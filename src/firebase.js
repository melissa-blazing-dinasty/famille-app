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
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

export const app = initializeApp(firebaseConfig);
// Note : on avait testé un cache local persistant pour que les données
// survivent à un F5/coupure réseau, mais ça bloquait Firestore
// entièrement sur Safari (iPhone), même hors PWA installée. On reste
// donc sur un Firestore standard, compatible partout.
export const db = getFirestore(app);
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
