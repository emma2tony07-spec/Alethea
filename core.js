// ─────────────────────────────────────────────────────────────
//  core.js  —  Business logic for Alethea
//  • Firebase init, auth, database
//  • Wallet generation, address derivation, signing
//  • PIN‑based encryption (PBKDF2 + AES‑GCM)
//  • Realtime listeners and state management
//  • No DOM manipulation – only exports data/functions
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  push,
  remove,
  onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ---------- Firebase config ----------
const firebaseConfig = {
  apiKey:            "AIzaSyDWQL7y-Al2DuOiqK8_c2p4sKpWC0M40rA",
  authDomain:        "alethea-876e1.firebaseapp.com",
  databaseURL:       "https://alethea-876e1-default-rtdb.firebaseio.com",
  projectId:         "alethea-876e1",
  storageBucket:     "alethea-876e1.firebasestorage.app",
  messagingSenderId: "670804167568",
  appId:             "1:670804167568:web:d63fb5609a99deb0df4115"
};

const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const database = getDatabase(firebaseApp);
export { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile };
export { ref, get, set, update, push, remove, onValue };

// ---------- Helpers ----------
export async function getUserWalletAddress(uid) {
  const snap = await get(ref(database, `users/${uid}/wallet`));
  return snap.exists() ? snap.val() : null;
}

// ---------- Crypto ----------
export async function generateECDSAKeyPair() {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const privateJWK = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicJWK  = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return { privateJWK, publicJWK, keyPair };
}

export async function deriveWalletAddress(publicJWK) {
  const cryptoKey = await window.crypto.subtle.importKey(
    'jwk', publicJWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['verify']
  );
  const rawBuf  = await window.crypto.subtle.exportKey('raw', cryptoKey);
  const hashBuf = await window.crypto.subtle.digest('SHA-256', rawBuf);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex;
}

export async function importPrivateKey(jwk) {
  return await window.crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
}

export async function signMessage(key, message) {
  const sig = await window.crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    new TextEncoder().encode(message)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---------- PIN‑based encryption (PBKDF2 + AES‑GCM) ----------
const ENC_ALGO = { name: 'AES-GCM', length: 256 };
const PBKDF2_ITERATIONS = 100000;

export async function deriveKeyFromPin(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    ENC_ALGO,
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPrivateKey(privateJWK, pin) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPin(pin, salt);
  const enc = new TextEncoder();
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: ENC_ALGO.name, iv },
    key,
    enc.encode(JSON.stringify(privateJWK))
  );
  return {
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  };
}

export async function decryptPrivateKey(encryptedBlob, pin) {
  const salt = Uint8Array.from(atob(encryptedBlob.salt), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encryptedBlob.iv), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encryptedBlob.ciphertext), c => c.charCodeAt(0));
  const key = await deriveKeyFromPin(pin, salt);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: ENC_ALGO.name, iv },
    key,
    ciphertext
  );
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(decrypted));
}

// ---------- Database helpers ----------
export async function getLiquidBalance(address) {
  const snap = await get(ref(database, `wallets/${address}`));
  return snap.exists() ? (snap.val().balance || 0) : 0;
}

export async function getChunkData(address, allJarNodeAddresses) {
  let total = 0;
  const list = [];
  for (const nodeAddr of allJarNodeAddresses) {
    if (nodeAddr === address) continue;
    const snap = await get(ref(database, `jarnodes/${nodeAddr}/chunks/${address}`));
    if (!snap.exists()) continue;
    for (const [key, data] of Object.entries(snap.val())) {
      const amount = data.amount || 0;
      total += amount;
      list.push({
        nodeAddr, chunkKey: key, amount,
        ref: ref(database, `jarnodes/${nodeAddr}/chunks/${address}/${key}`)
      });
    }
  }
  return { total, chunks: list };
}

export async function getTotalBalance(address, allJarNodeAddresses) {
  const [liquid, { total: stored }] = await Promise.all([
    getLiquidBalance(address),
    getChunkData(address, allJarNodeAddresses)
  ]);
  return { liquid, stored, total: liquid + stored };
}

export async function loadJarNodeAddresses() {
  const snap = await get(ref(database, 'jarnodes'));
  return snap.exists()
    ? Object.keys(snap.val()).filter(a => snap.val()[a].enabled === true)
    : [];
}

export async function getUserPreferences(uid) {
  const snap = await get(ref(database, `users/${uid}/prefs`));
  return snap.exists() ? snap.val() : { jarNodesEnabled: false, jarDistributionMode: 'manual' };
}

// ---------- Realtime listener management ----------
export function createRealtimeListeners(address, onWalletChange, onPendingChange, onBlocksChange) {
  const unsubs = [];
  unsubs.push(onValue(ref(database, `wallets/${address}`), onWalletChange));
  unsubs.push(onValue(ref(database, 'blockchain/pending_transactions'), onPendingChange));
  unsubs.push(onValue(ref(database, 'blockchain/blocks'), onBlocksChange));
  return () => unsubs.forEach(fn => fn());
}