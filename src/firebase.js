// Remplace ces valeurs par celles de TON projet Firebase.
// Console Firebase > Paramètres du projet > Tes applications > Config SDK
export const firebaseConfig = {
  apiKey: "AIzaSyBt6X96p_Y02VhIvtf_2YbgA1S0A2XtXEg",
  authDomain: "app-familly.firebaseapp.com",
  projectId: "app-familly",
  storageBucket: "app-familly.firebasestorage.app",
  messagingSenderId: "332492798587",
  appId: "1:332492798587:web:97fa467ea40bfd90d980de",
};

import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

export const app = initializeApp(firebaseConfig);
// Cache local persistant : les données lues et les écritures en attente
// survivent à un rechargement de page (F5) ou une coupure réseau
// temporaire. Sur certains navigateurs (notamment Safari/iPhone, en
// particulier en appli installée), l'initialisation de ce cache peut
// échouer silencieusement et bloquer TOUT Firestore. On retombe alors
// sur un Firestore classique (sans persistance locale) pour que l'appli
// continue de fonctionner partout, quitte à perdre juste ce confort-là.
let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache(),
  });
} catch (e) {
  console.error("Cache persistant Firestore indisponible, repli sur le mode standard.", e);
  dbInstance = getFirestore(app);
}
export const db = dbInstance;
export const auth = getAuth(app);

// Connexion anonyme automatique : pas d'écran de login,
// chaque appareil obtient juste une identité technique pour Firestore.
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) resolve(user);
      else signInAnonymously(auth).then((cred) => resolve(cred.user)).catch(reject);
    });
  });
}
