import config from "../config.ts";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

if (config.FIREBASE_ADMIN_SDK_CONFIG) {
  initializeApp({
    credential: cert(JSON.parse(config.FIREBASE_ADMIN_SDK_CONFIG)),
    databaseURL: config.FIREBASE_DATABASE_URL,
  });
}

export async function validateUserToken(uid: string, token: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return undefined;
  }
  if (!token) {
    return undefined;
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (uid !== decoded.uid) {
      // Valid but for wrong user
      return undefined;
    }
    return decoded;
  } catch (e) {
    // Promise rejects if verification failed
    console.log(e);
    return undefined;
  }
}

export async function writeData(key: string, value: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return;
  }
  await getDatabase().ref(key).set(value);
}

export async function getUser(uid: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return null;
  }
  return await getAuth().getUser(uid);
}

export async function deleteUser(uid: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return null;
  }
  return getAuth().deleteUser(uid);
}
