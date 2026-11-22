// Noise_XK_25519_AESGCM_SHA256 (Noise revision 34), on WebCrypto alone, so
// the browser's static key can be a non-extractable CryptoKey. The game side
// is sculk's core/src/main/java/sculk/core/remote/NoiseXK.java; both are
// checked against the same published vectors (test/noise-vectors.json).
//
//   XK:
//     <- s
//     ...
//     -> e, es
//     <- e, ee
//     -> s, se
//
// The browser is the initiator: it knows the game's key from the link, and
// sends its own encrypted in the third message, so relays never learn which
// browser is connecting.

export type Bytes = Uint8Array<ArrayBuffer>;

/** An X25519 key pair: the public key as Noise writes it, the private key as a CryptoKey. */
export interface KeyPair {
  readonly pub: Bytes;
  readonly priv: CryptoKey;
}

export const PROTOCOL = "Noise_XK_25519_AESGCM_SHA256";
/** Noise's limit on any one message. */
export const MAX_MESSAGE = 65535;
const DH_LEN = 32;
const HASH_LEN = 32;
const TAG_LEN = 16;

const subtle = globalThis.crypto.subtle;
const X25519 = { name: "X25519" } as const;

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const BASE_POINT: Bytes = new Uint8Array(DH_LEN);
BASE_POINT[0] = 9;

/** A new key pair; the private key cannot be exported unless asked. */
export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const k = (await subtle.generateKey(X25519, extractable, ["deriveBits"])) as CryptoKeyPair;
  return { pub: new Uint8Array(await subtle.exportKey("raw", k.publicKey)), priv: k.privateKey };
}

/** The key pair with this 32-byte private key: for test vectors. */
export async function keyPairFromPrivate(raw: Bytes): Promise<KeyPair> {
  if (raw.length !== DH_LEN) throw new Error(`X25519 private key: ${raw.length} bytes`);
  // PKCS #8 for X25519 (RFC 8410) is a fixed 16-byte prefix and the key.
  const prefix = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
  const priv = await subtle.importKey("pkcs8", concat(prefix, raw), X25519, false, ["deriveBits"]);
  // The public key is the private key times the base point.
  return { pub: await dh(priv, BASE_POINT), priv };
}

/** The shared secret; refuses a small-order peer key (an all-zero result), as Noise allows. */
export async function dh(priv: CryptoKey, peer: Bytes): Promise<Bytes> {
  if (peer.length !== DH_LEN) throw new Error(`X25519 public key: ${peer.length} bytes`);
  const pub = await subtle.importKey("raw", peer, X25519, true, []);
  const out = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, priv, DH_LEN * 8));
  if (out.every((b) => b === 0)) throw new Error("X25519: small-order public key");
  return out;
}

async function sha256(...parts: Bytes[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}

async function hmac(key: Bytes, ...parts: Bytes[]): Promise<Bytes> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, concat(...parts)));
}

/** Noise's HKDF (RFC 5869 with an empty info), giving 2 or 3 outputs. */
async function hkdf(ck: Bytes, ikm: Bytes, outputs: 2 | 3): Promise<Bytes[]> {
  const temp = await hmac(ck, ikm);
  const out: Bytes[] = [];
  let prev: Bytes = new Uint8Array(0);
  for (let i = 1; i <= outputs; i++) {
    prev = await hmac(temp, prev, new Uint8Array([i]));
    out.push(prev);
  }
  return out;
}

/** A key and a nonce counter: Noise's CipherState, with AES-256-GCM. */
export class CipherState {
  private key: CryptoKey | null = null;
  // Kept as a bigint: Noise nonces are 64-bit.
  private n = 0n;

  static async of(k: Bytes): Promise<CipherState> {
    const c = new CipherState();
    await c.initializeKey(k);
    return c;
  }

  async initializeKey(k: Bytes): Promise<void> {
    this.key = await subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
    this.n = 0n;
  }

  /** AES-GCM's nonce: 32 zero bits, then n big-endian. */
  private nonce(): Bytes {
    if (this.n === 0xffff_ffff_ffff_ffffn) throw new Error("nonce exhausted"); // reserved
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.n, false);
    return iv;
  }

  async encrypt(ad: Bytes, plaintext: Bytes): Promise<Bytes> {
    if (this.key === null) return plaintext.slice();
    const params = { name: "AES-GCM", iv: this.nonce(), additionalData: ad, tagLength: TAG_LEN * 8 };
    const out = new Uint8Array(await subtle.encrypt(params, this.key, plaintext));
    this.n++;
    return out;
  }

  /** Rejects if it does not authenticate; the nonce then does not advance. */
  async decrypt(ad: Bytes, ciphertext: Bytes): Promise<Bytes> {
    if (this.key === null) return ciphertext.slice();
    const params = { name: "AES-GCM", iv: this.nonce(), additionalData: ad, tagLength: TAG_LEN * 8 };
    const out = new Uint8Array(await subtle.decrypt(params, this.key, ciphertext));
    this.n++;
    return out;
  }
}

/** Noise's SymmetricState: the chaining key, the hash, and the cipher between them. */
class Symmetric {
  readonly cs = new CipherState();

  private constructor(
    public ck: Bytes,
    public h: Bytes,
  ) {}

  static async of(protocol: string): Promise<Symmetric> {
    const name = new TextEncoder().encode(protocol) as Bytes;
    const h = name.length <= HASH_LEN ? concat(name, new Uint8Array(HASH_LEN - name.length)) : await sha256(name);
    return new Symmetric(h.slice(), h);
  }

  async mixKey(ikm: Bytes): Promise<void> {
    const [ck, k] = await hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    await this.cs.initializeKey(k!); // HASHLEN is 32, the AES-256 key length
  }

  async mixHash(data: Bytes): Promise<void> {
    this.h = await sha256(this.h, data);
  }

  async encryptAndHash(plaintext: Bytes): Promise<Bytes> {
    const c = await this.cs.encrypt(this.h, plaintext);
    await this.mixHash(c);
    return c;
  }

  async decryptAndHash(ciphertext: Bytes): Promise<Bytes> {
    const p = await this.cs.decrypt(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return p;
  }
}

/** The ciphers after the handshake. Each direction's nonces count up from 0. */
export interface Transport {
  readonly send: CipherState;
  readonly receive: CipherState;
}

/**
 * One XK handshake. The game is the responder; the browser the initiator.
 * Calls must not overlap: await each before the next.
 */
export class NoiseXK {
  private e: KeyPair | null = null;
  private re: Bytes | null = null;
  /** Messages done: 0 to 3. */
  private step = 0;

  private constructor(
    private readonly initiator: boolean,
    private readonly s: KeyPair,
    private rs: Bytes | null,
    private readonly sym: Symmetric,
    private readonly ephemerals: () => Promise<KeyPair>,
  ) {}

  /** The browser's side: its own static key, and the server's from the link. */
  static async initiator(
    s: KeyPair,
    serverStatic: Bytes,
    prologue: Bytes,
    ephemerals: () => Promise<KeyPair> = () => generateKeyPair(),
  ): Promise<NoiseXK> {
    if (serverStatic.length !== DH_LEN) throw new Error(`server key: ${serverStatic.length} bytes`);
    const sym = await Symmetric.of(PROTOCOL);
    await sym.mixHash(prologue);
    await sym.mixHash(serverStatic); // the pre-message
    return new NoiseXK(true, s, serverStatic.slice(), sym, ephemerals);
  }

  /** The game's side; here for tests and for sculkctl-like clients. */
  static async responder(
    s: KeyPair,
    prologue: Bytes,
    ephemerals: () => Promise<KeyPair> = () => generateKeyPair(),
  ): Promise<NoiseXK> {
    const sym = await Symmetric.of(PROTOCOL);
    await sym.mixHash(prologue);
    await sym.mixHash(s.pub); // the pre-message
    return new NoiseXK(false, s, null, sym, ephemerals);
  }

  get complete(): boolean {
    return this.step === 3;
  }

  /** Whether the next handshake message is ours to write. */
  get ourTurn(): boolean {
    return !this.complete && (this.step % 2 === 0) === this.initiator;
  }

  /** The next handshake message, carrying `payload` (encrypted in all three). */
  async writeMessage(payload: Bytes): Promise<Bytes> {
    if (!this.ourTurn) throw new Error(`not our turn to write (step ${this.step})`);
    const parts: Bytes[] = [];
    switch (this.step) {
      case 0: // -> e, es
        parts.push(await this.writeEphemeral());
        await this.sym.mixKey(await dh(this.e!.priv, this.rs!));
        break;
      case 1: // <- e, ee
        parts.push(await this.writeEphemeral());
        await this.sym.mixKey(await dh(this.e!.priv, this.re!));
        break;
      case 2: // -> s, se
        parts.push(await this.sym.encryptAndHash(this.s.pub));
        await this.sym.mixKey(await dh(this.s.priv, this.re!));
        break;
    }
    parts.push(await this.sym.encryptAndHash(payload));
    const out = concat(...parts);
    if (out.length > MAX_MESSAGE) throw new Error(`message over ${MAX_MESSAGE} bytes`);
    this.step++;
    return out;
  }

  /** Reads the peer's next handshake message and returns its payload; rejects if it does not authenticate. */
  async readMessage(message: Bytes): Promise<Bytes> {
    if (this.complete || this.ourTurn) throw new Error(`not our turn to read (step ${this.step})`);
    if (message.length > MAX_MESSAGE) throw new Error(`message over ${MAX_MESSAGE} bytes`);
    let at = 0;
    switch (this.step) {
      case 0: // -> e, es (we are the responder)
        at = await this.readEphemeral(message);
        await this.sym.mixKey(await dh(this.s.priv, this.re!));
        break;
      case 1: // <- e, ee (we are the initiator)
        at = await this.readEphemeral(message);
        await this.sym.mixKey(await dh(this.e!.priv, this.re!));
        break;
      case 2: {
        // -> s, se (we are the responder)
        const len = DH_LEN + TAG_LEN;
        if (message.length < len) throw new Error("short handshake message");
        this.rs = await this.sym.decryptAndHash(message.slice(0, len));
        at = len;
        await this.sym.mixKey(await dh(this.e!.priv, this.rs));
        break;
      }
    }
    const payload = await this.sym.decryptAndHash(message.slice(at));
    this.step++;
    return payload;
  }

  private async writeEphemeral(): Promise<Bytes> {
    this.e = await this.ephemerals();
    await this.sym.mixHash(this.e.pub);
    return this.e.pub;
  }

  private async readEphemeral(message: Bytes): Promise<number> {
    if (message.length < DH_LEN) throw new Error("short handshake message");
    this.re = message.slice(0, DH_LEN);
    await this.sym.mixHash(this.re);
    return DH_LEN;
  }

  /** The peer's static key: the server's for the initiator, the browser's after message 3 for the responder. */
  get remoteStatic(): Bytes | null {
    return this.rs?.slice() ?? null;
  }

  /** The handshake hash, which both sides share once the handshake is complete. */
  get handshakeHash(): Bytes {
    if (!this.complete) throw new Error("handshake not complete");
    return this.sym.h.slice();
  }

  /** The two transport ciphers: ours to send with, and ours to receive with. */
  async split(): Promise<Transport> {
    if (!this.complete) throw new Error("handshake not complete");
    const [k1, k2] = await hkdf(this.sym.ck, new Uint8Array(0), 2);
    const c1 = await CipherState.of(k1!);
    const c2 = await CipherState.of(k2!);
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}
