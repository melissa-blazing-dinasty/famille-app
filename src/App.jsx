import { useState, useEffect, useMemo, useRef } from "react";
import {
  Wallet, CalendarDays, BookOpen, Plus, Trash2, X, Search,
  Upload, TrendingUp, TrendingDown, Link as LinkIcon,
  PiggyBank, Baby, Calendar, ListChecks, Star, Gift, ExternalLink, CheckCircle2, Lightbulb, Bell, Lock, Unlock, Minus, Sun, Moon, Cookie, RefreshCw, Save, ChevronDown, Dumbbell, Trophy, Ruler, Activity, Wind, Flame, Zap
} from "lucide-react";
import Papa from "papaparse";
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { db, ensureSignedIn } from "./firebase.js";
import { doc, onSnapshot, setDoc, serverTimestamp, waitForPendingWrites } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */
const PAPER = "#F6F1E7";
const PAPER_DARK = "#EFE7D8";
const INK = "#332F28";
const INK_SOFT = "#6B6357";
const TAN = "#CBA876";
const LINE = "#DCD0B8";

const ORDRE_ESPACE_ENFANT_GLOBAL = ["enfants", "sport", "todo", "menus", "recettes"];
const ACCENTS = {
  budget: { main: "#5F7A5A", soft: "#E4EBDF", deep: "#425840" },
  menus: { main: "#C17A3B", soft: "#F5E4D2", deep: "#8C5527" },
  recettes: { main: "#8A4A66", soft: "#F0DEE6", deep: "#63324A" },
  epargne: { main: "#3E7C74", soft: "#DCEAE7", deep: "#275F58" },
  enfants: { main: "#C99A2E", soft: "#F5EBD2", deep: "#8F6B18" },
  planning: { main: "#4C5B8C", soft: "#E1E4F0", deep: "#333F66" },
  todo: { main: "#5A6570", soft: "#E7EAEC", deep: "#3C444C" },
  sport: { main: "#B5453A", soft: "#F3DEDB", deep: "#7E2F27" },
};

const DEFAULT_CATEGORIES = ["Alimentation", "Logement", "Transport", "Loisirs", "Santé", "Enfants", "Autres"];
const TYPES_PLAT = ["Entrée", "Plat", "Dessert", "Goûter"];
const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function uid() { return Math.random().toString(36).slice(2, 10); }

/* ------------------------------------------------------------------ */
/* Déverrouillage biométrique du mode parent (Face ID / empreinte /    */
/* Windows Hello), via l'API standard WebAuthn du navigateur. Ça       */
/* s'enregistre PAR APPAREIL (stocké dans le localStorage de ce        */
/* téléphone/ordinateur) — chacun active la sienne sur son appareil.   */
/* ------------------------------------------------------------------ */
function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
function biometrieDisponible() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}
function cleBiometrie(familyCode) {
  return `bioCredId_${familyCode}`;
}
async function enregistrerBiometrie(familyCode) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Carnet de famille" },
      user: { id: userId, name: "parent", displayName: "Parent" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
    },
  });
  localStorage.setItem(cleBiometrie(familyCode), bufToBase64(cred.rawId));
}
async function deverrouillerAvecBiometrie(familyCode) {
  const credId = localStorage.getItem(cleBiometrie(familyCode));
  if (!credId) return false;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: base64ToBuf(credId), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return true; // si ça n'a pas levé d'erreur, la vérification (Face ID/empreinte) a réussi
}

function todayISO() {
  const d = new Date();
  const annee = d.getFullYear();
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  const jour = String(d.getDate()).padStart(2, "0");
  return `${annee}-${mois}-${jour}`;
}
function formatEUR(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}
function formatDateFR(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return `${JOURS_FR[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString("fr-FR", { month: "long" })}`;
}

/* ------------------------------------------------------------------ */
/* Stockage Firestore (remplace window.storage) — un doc par clé,       */
/* dans familles/{familyCode}/store/{key}, synchronisé en temps réel    */
/* entre tous les appareils utilisant le même code famille.             */
/*                                                                       */
/* Point important : chaque écriture déclenche automatiquement un       */
/* nouvel évènement de lecture (c'est l'écho de notre propre écriture). */
/* Ce hook mémorise la dernière valeur qu'IL a lui-même envoyée, et      */
/* ignore l'écho quand il revient identique — sans ça, ça part en       */
/* boucle infinie écriture → lecture → écriture qui épuise le quota     */
/* gratuit de Firestore en quelques minutes.                            */
/* ------------------------------------------------------------------ */
function keyDocRef(familyCode, key) {
  return doc(db, "familles", familyCode, "store", key);
}
// Firestore refuse tout champ "undefined" — il rejette l'écriture ENTIÈRE
// sans que ça se voie dans l'appli si on ne fait pas attention. On nettoie
// donc toujours nos données (undefined -> null) avant d'écrire.
function nettoyerPourFirestore(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(nettoyerPourFirestore);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = nettoyerPourFirestore(value[k]);
    return out;
  }
  return value;
}
async function saveKeyFS(familyCode, key, value) {
  try {
    await setDoc(keyDocRef(familyCode, key), { value: nettoyerPourFirestore(value), updatedAt: serverTimestamp() });
    return true;
  } catch (e) {
    console.error("Erreur de sauvegarde", key, e);
    return false;
  }
}

// Petit système pour remonter les erreurs Firestore jusqu'à l'interface
// (utile pour diagnostiquer sur un appareil où on n'a pas accès à la
// console technique, comme un iPhone).
const firestoreErrorListeners = new Set();
function reportFirestoreError(key, err) {
  const message = `${key} : ${err?.code || err?.message || String(err)}`;
  firestoreErrorListeners.forEach((fn) => fn(message));
}

function useFirestoreArray(familyCode, authReady, key, fallback) {
  const [value, setValueState] = useState(fallback);
  const [ready, setReady] = useState(false);
  const lastKnown = useRef(null); // dernière valeur (nous ou distante) reçue/envoyée, en JSON

  useEffect(() => {
    if (!familyCode || !authReady) return;
    setReady(false);
    lastKnown.current = null;
    const unsub = onSnapshot(
      keyDocRef(familyCode, key),
      (snap) => {
        const incoming = snap.exists() && snap.data().value !== undefined ? snap.data().value : fallback;
        const incomingStr = JSON.stringify(incoming);
        if (incomingStr !== lastKnown.current) {
          lastKnown.current = incomingStr;
          setValueState(incoming);
        }
        setReady(true);
      },
      (err) => { console.error("Erreur de lecture", key, err); reportFirestoreError(key, err); setReady(true); }
    );
    return () => unsub();
  }, [familyCode, authReady, key]);

  const setValue = (updater) => {
    setValueState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const nextStr = JSON.stringify(next);
      if (nextStr !== lastKnown.current) {
        lastKnown.current = nextStr;
        saveKeyFS(familyCode, key, next).then((ok) => {
          if (!ok) reportFirestoreError(key, "échec de l'écriture (voir console)");
        });
      }
      return next;
    });
  };

  return [value, setValue, ready];
}

/* ------------------------------------------------------------------ */
/* Notifications locales (OS, via l'appli installée)                   */
/* Fonctionnent quand l'appli est ouverte ou récemment mise en arrière- */
/* plan. Une vraie notification push (appli fermée) demande en plus    */
/* Firebase Cloud Messaging + une Cloud Function côté serveur.          */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Forcer la mise à jour : vide le cache du service worker (PWA) et    */
/* recharge la dernière version publiée, sans attendre la mise à jour  */
/* automatique en arrière-plan.                                        */
/* ------------------------------------------------------------------ */
async function forcerMiseAJour() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) { await reg.update(); }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {
    console.error("Erreur pendant la mise à jour", e);
  } finally {
    window.location.reload();
  }
}

function useNotifierDuJour(taches, planning) {
  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") Notification.requestPermission();
  }, []);

  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const today = todayISO();
    const dejaNotifiees = JSON.parse(sessionStorage.getItem("notif_envoyees") || "[]");
    const aNotifier = [];
    taches.filter((t) => t.rappelDate === today && !t.fait).forEach((t) => aNotifier.push(`tache-${t.id}`));
    planning.filter((p) => p.date === today).forEach((p) => aNotifier.push(`event-${p.id}`));
    const nouvelles = aNotifier.filter((id) => !dejaNotifiees.includes(id));
    if (nouvelles.length) {
      new Notification("Carnet de famille", {
        body: `${nouvelles.length} chose(s) prévue(s) aujourd'hui.`,
        icon: "/icon-192.png",
      });
      sessionStorage.setItem("notif_envoyees", JSON.stringify([...dejaNotifiees, ...nouvelles]));
    }
  }, [taches, planning]);
}

/* ------------------------------------------------------------------ */
/* App                                                                  */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Écran d'entrée : code famille (partagé entre tous les appareils)    */
/* ------------------------------------------------------------------ */
function normaliserCode(c) {
  return c.replace(/\s+/g, "");
}

function FamilyCodeGate({ onValidate }) {
  const [code, setCode] = useState("");
  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6" style={{ background: PAPER }}>
      <div className="max-w-sm w-full rounded-lg border p-6 bg-white/70" style={{ borderColor: LINE }}>
        <h1 className="text-2xl font-serif font-semibold mb-1" style={{ color: INK }}>Carnet de famille</h1>
        <p className="text-sm mb-4" style={{ color: INK_SOFT }}>
          Choisis un code unique pour ta famille (invente-le librement, à retenir).
          Tous les appareils qui entrent le même code partagent les mêmes données.
        </p>
        <input
          className="w-full border rounded-md px-3 py-2 text-sm mb-3"
          style={{ borderColor: LINE }}
          placeholder="Ex. dupont-maison-2026"
          value={code}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck="false"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && normaliserCode(code)) onValidate(normaliserCode(code)); }}
        />
        <button
          onClick={() => normaliserCode(code) && onValidate(normaliserCode(code))}
          className="w-full h-10 rounded-md text-sm font-semibold text-white"
          style={{ background: ACCENTS.budget.main }}
        >
          Entrer dans l'appli
        </button>
        <p className="text-xs mt-3" style={{ color: INK_SOFT }}>
          Choisis un code assez long et pas trop devinable : il fait office de clé d'accès aux données de ta famille.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("budget");
  // À chaque ouverture de l'appli, on redemande "enfant ou adulte" (jamais
  // mémorisé) — passer adulte exige le code PIN parent.
  const [espaceChoisi, setEspaceChoisi] = useState(null); // null | "enfant" | "adulte"
  const espaceEnfant = espaceChoisi === "enfant";
  const [enfantActifId, setEnfantActifId] = useState(null);
  const [pinAdulteSaisi, setPinAdulteSaisi] = useState("");
  const [erreurPinAdulte, setErreurPinAdulte] = useState("");
  const validerAdulte = () => {
    if (!parentPin) {
      if (pinAdulteSaisi.trim().length < 4) { setErreurPinAdulte("Choisis un code d'au moins 4 chiffres."); return; }
      setParentPin(pinAdulteSaisi.trim());
      setEspaceChoisi("adulte");
      setPinAdulteSaisi(""); setErreurPinAdulte("");
      return;
    }
    if (pinAdulteSaisi === parentPin) { setEspaceChoisi("adulte"); setPinAdulteSaisi(""); setErreurPinAdulte(""); }
    else setErreurPinAdulte("Code incorrect.");
  };
  const [familyCode, setFamilyCode] = useState(() => localStorage.getItem("familyCode") || "");
  const [authReady, setAuthReady] = useState(false);
  const [syncErrors, setSyncErrors] = useState([]);

  // Connexion anonyme Firebase (une fois, avant tout accès Firestore)
  useEffect(() => {
    ensureSignedIn()
      .then(() => setAuthReady(true))
      .catch((err) => setSyncErrors((prev) => [...prev.slice(-3), `connexion : ${err?.code || err?.message || err}`]));
    // Si la connexion reste bloquée plus de 10 secondes, on le signale
    // (utile sur des navigateurs qui bloquent silencieusement le stockage
    // nécessaire à l'authentification, comme certaines configs Safari).
    const timeout = setTimeout(() => {
      setAuthReady((ready) => {
        if (!ready) setSyncErrors((prev) => [...prev.slice(-3), "connexion : bloquée depuis plus de 10s (voir ci-dessous)"]);
        return ready;
      });
    }, 10000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const listener = (message) => setSyncErrors((prev) => [...prev.slice(-3), message]);
    firestoreErrorListeners.add(listener);
    return () => firestoreErrorListeners.delete(listener);
  }, []);

  const [comptes, setComptes, r1] = useFirestoreArray(familyCode, authReady, "comptes", []);
  const [transactions, setTransactions, r2] = useFirestoreArray(familyCode, authReady, "transactions", []);
  const [categories, setCategories, r3] = useFirestoreArray(familyCode, authReady, "categories", DEFAULT_CATEGORIES);
  const [recettes, setRecettes, r4] = useFirestoreArray(familyCode, authReady, "recettes", []);
  const [menus, setMenus, r5] = useFirestoreArray(familyCode, authReady, "menus", []);
  const [baseMensuelle, setBaseMensuelle, r6] = useFirestoreArray(familyCode, authReady, "baseMensuelle", []);
  const [epargnes, setEpargnes, r7] = useFirestoreArray(familyCode, authReady, "epargnes", []);
  const [enfants, setEnfants, r8] = useFirestoreArray(familyCode, authReady, "enfants", []);
  const [taches, setTaches, r9] = useFirestoreArray(familyCode, authReady, "taches", []);
  const [recompenses, setRecompenses, r10] = useFirestoreArray(familyCode, authReady, "recompenses", []);
  const [menuIdees, setMenuIdees, r11] = useFirestoreArray(familyCode, authReady, "menuIdees", []);
  const [planning, setPlanning, r12] = useFirestoreArray(familyCode, authReady, "planning", []);
  const [todos, setTodos, r13] = useFirestoreArray(familyCode, authReady, "todos", []);
  const [parentPin, setParentPin, r14] = useFirestoreArray(familyCode, authReady, "parentPin", "");
  const [budgetQuotidien, setBudgetQuotidien, r15] = useFirestoreArray(familyCode, authReady, "budgetQuotidien", []);
  const [decouvert, setDecouvert, r16] = useFirestoreArray(familyCode, authReady, "decouvert", { debutMois: 0, rembourseCeMois: 0 });
  const [extrasImprevus, setExtrasImprevus, r17] = useFirestoreArray(familyCode, authReady, "extrasImprevus", []);
  const [courses, setCourses, r18] = useFirestoreArray(familyCode, authReady, "courses", []);
  const [sportMembres, setSportMembres, r19] = useFirestoreArray(familyCode, authReady, "sportMembres", []);
  const [mensurations, setMensurations, r20] = useFirestoreArray(familyCode, authReady, "mensurations", []);
  const [seancesSport, setSeancesSport, r21] = useFirestoreArray(familyCode, authReady, "seancesSport", []);
  const [sanctions, setSanctions, r22] = useFirestoreArray(familyCode, authReady, "sanctions", []);
  const [exercicesPerso, setExercicesPerso, r23] = useFirestoreArray(familyCode, authReady, "exercicesPerso", []);
  const [sanctionsPerso, setSanctionsPerso, r24] = useFirestoreArray(familyCode, authReady, "sanctionsPerso", []);
  const [lecturesSessions, setLecturesSessions, r25] = useFirestoreArray(familyCode, authReady, "lecturesSessions", []);
  const loaded = r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r16 && r17 && r18 && r19 && r20 && r21 && r22 && r23 && r24 && r25;

  useNotifierDuJour(taches, planning);

  const [saveStatus, setSaveStatus] = useState("");
  // Revient à l'écran "Enfant ou Adulte" — repasser adulte redemandera le code PIN.
  const revenirAuChoixEspace = () => {
    setEspaceChoisi(null);
    setEnfantActifId(null);
  };

  const enregistrerMaintenant = async () => {
    setSaveStatus("saving");
    setSaveStatus("saving");
    const entries = [
      ["comptes", comptes], ["transactions", transactions], ["categories", categories],
      ["recettes", recettes], ["menus", menus], ["baseMensuelle", baseMensuelle],
      ["epargnes", epargnes], ["enfants", enfants], ["taches", taches],
      ["recompenses", recompenses], ["menuIdees", menuIdees], ["planning", planning],
      ["todos", todos], ["parentPin", parentPin], ["budgetQuotidien", budgetQuotidien],
      ["decouvert", decouvert], ["extrasImprevus", extrasImprevus], ["courses", courses],
    ];
    const results = await Promise.all(entries.map(([k, v]) => saveKeyFS(familyCode, k, v)));
    if (!results.every(Boolean)) {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus(""), 4000);
      return;
    }
    // Une écriture Firestore peut sembler réussir instantanément alors
    // qu'elle est juste mise en file d'attente localement (hors-ligne,
    // réseau capricieux...). On attend une VRAIE confirmation du serveur,
    // avec une limite de temps pour ne pas bloquer indéfiniment.
    try {
      await Promise.race([
        waitForPendingWrites(db),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
      setSaveStatus("ok");
    } catch (e) {
      setSaveStatus("offline");
    }
    setTimeout(() => setSaveStatus(""), 4500);
  };

  if (!familyCode) {
    return <FamilyCodeGate onValidate={(code) => { localStorage.setItem("familyCode", code); setFamilyCode(code); }} />;
  }

  if (loaded && !espaceChoisi) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center p-6" style={{ background: PAPER }}>
        <div className="max-w-sm w-full rounded-lg border p-6 bg-white/70 text-center" style={{ borderColor: LINE }}>
          <h1 className="text-2xl font-serif font-semibold mb-1" style={{ color: INK }}>👋 Bienvenue !</h1>
          <p className="text-sm mb-6" style={{ color: INK_SOFT }}>Qui utilise l'appli en ce moment ?</p>
          <div className="flex flex-col gap-3">
            <button onClick={() => setEspaceChoisi("enfant")}
              className="py-4 rounded-lg text-lg font-semibold border-2"
              style={{ borderColor: ACCENTS.enfants.main, color: ACCENTS.enfants.deep, background: ACCENTS.enfants.soft }}>
              🎈 Je suis un enfant
            </button>
            <div className="pt-2 border-t" style={{ borderColor: LINE }}>
              <p className="text-xs mt-3 mb-2" style={{ color: INK_SOFT }}>Je suis un adulte — code parent :</p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  inputMode="numeric"
                  className="flex-1 border rounded-md px-3 py-2 text-sm text-center"
                  style={{ borderColor: LINE }}
                  placeholder={parentPin ? "Code parent" : "Choisis un code (4 chiffres min.)"}
                  value={pinAdulteSaisi}
                  onChange={(e) => setPinAdulteSaisi(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && validerAdulte()}
                />
                <button onClick={validerAdulte} className="h-9 px-4 rounded-md text-sm font-semibold text-white shrink-0" style={{ background: ACCENTS.budget.main }}>
                  {parentPin ? "Entrer" : "Créer"}
                </button>
              </div>
              {erreurPinAdulte && <p className="text-xs mt-2" style={{ color: "#A33B3B" }}>{erreurPinAdulte}</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: "budget", label: "Budget", icon: Wallet, accent: ACCENTS.budget },
    { id: "epargne", label: "Épargne", icon: PiggyBank, accent: ACCENTS.epargne },
    { id: "menus", label: "Menus", icon: CalendarDays, accent: ACCENTS.menus },
    { id: "recettes", label: "Recettes", icon: BookOpen, accent: ACCENTS.recettes },
    { id: "enfants", label: "Bons points", icon: Baby, accent: ACCENTS.enfants },
    { id: "planning", label: "Planning", icon: Calendar, accent: ACCENTS.planning },
    { id: "todo", label: "À faire", icon: ListChecks, accent: ACCENTS.todo },
    { id: "sport", label: "Sport", icon: Dumbbell, accent: ACCENTS.sport },
  ];
  // Espace enfant : uniquement ces 5 onglets, dans cet ordre, sans accès au Budget/Épargne/Planning.
  const tabsAffiches = espaceEnfant
    ? ORDRE_ESPACE_ENFANT_GLOBAL.map((id) => tabs.find((t) => t.id === id))
    : tabs;
  const active = tabsAffiches.find((t) => t.id === tab) || tabsAffiches[0];

  return (
    <div className="min-h-screen w-full flex flex-col sm:flex-row" style={{ background: PAPER, color: INK, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {!!syncErrors.length && (
        <div className="fixed top-0 left-0 right-0 z-50 p-3" style={{ background: "#A33B3B" }}>
          <p className="text-xs text-white font-semibold mb-1">⚠️ Problème de connexion aux données — copie ce message pour le support :</p>
          {syncErrors.map((msg, i) => (
            <p key={i} className="text-xs text-white font-mono break-all">{msg}</p>
          ))}
        </div>
      )}
      {/* Onglets style classeur */}
      <nav className="flex sm:flex-col shrink-0 sm:w-20 border-b sm:border-b-0 sm:border-r overflow-x-auto sm:overflow-y-auto" style={{ borderColor: LINE }}>
        {tabsAffiches.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex flex-col shrink-0 items-center justify-center gap-1 min-w-[68px] sm:min-w-0 px-2 py-3 sm:py-6 transition-all relative focus:outline-none"
              style={{
                background: isActive ? t.accent.main : "transparent",
                color: isActive ? "#fff" : INK_SOFT,
              }}
            >
              <Icon size={19} strokeWidth={1.75} />
              <span className="text-[10px] font-semibold tracking-wide whitespace-nowrap">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <main className="flex-1 min-w-0">
        <header className="px-5 sm:px-8 py-5 border-b flex items-start justify-between gap-3" style={{ borderColor: LINE, background: espaceEnfant ? ACCENTS.enfants.soft : PAPER_DARK }}>
          <div>
            {espaceEnfant ? (
              <p className="text-[11px] uppercase tracking-[0.2em] font-semibold" style={{ color: ACCENTS.enfants.deep }}>🎉 Mon espace</p>
            ) : (
              <p className="text-[11px] uppercase tracking-[0.2em] font-semibold" style={{ color: active.accent.main }}>
                Carnet de famille · <span className="normal-case tracking-normal font-mono" style={{ color: INK_SOFT }}>code : {familyCode} ({familyCode.length} car.)</span>
                {" "}
                <button
                  onClick={() => { if (window.confirm("Changer de code famille ? Tu devras retaper le bon code pour retrouver tes données.")) { localStorage.removeItem("familyCode"); window.location.reload(); } }}
                  className="normal-case tracking-normal underline"
                  style={{ color: INK_SOFT }}
                >
                  (changer)
                </button>
              </p>
            )}
            <h1 className="text-2xl sm:text-3xl font-serif font-semibold mt-0.5" style={{ color: INK }}>{active.label}</h1>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={revenirAuChoixEspace}
              title={espaceEnfant ? "Revenir à l'espace complet (code parent requis)" : "Changer d'espace"}
              className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md border"
              style={{
                borderColor: espaceEnfant ? ACCENTS.enfants.main : LINE,
                color: espaceEnfant ? "#fff" : INK_SOFT,
                background: espaceEnfant ? ACCENTS.enfants.main : "transparent",
              }}
            >
              {espaceEnfant ? "🔒" : "🔄"}
              <span className="hidden sm:inline">{espaceEnfant ? "Espace enfant (changer)" : "Changer d'espace"}</span>
            </button>
            <button
              onClick={enregistrerMaintenant}
              title="Force l'enregistrement immédiat de toutes les données, avec confirmation du serveur"
              className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md border"
              style={{
                borderColor: saveStatus === "error" || saveStatus === "offline" ? "#A33B3B" : LINE,
                color: saveStatus === "ok" ? active.accent.deep : (saveStatus === "error" || saveStatus === "offline") ? "#A33B3B" : INK_SOFT,
                background: saveStatus === "ok" ? active.accent.soft : "transparent",
              }}
            >
              <Save size={13} />
              <span className="hidden sm:inline">
                {saveStatus === "saving" ? "Enregistrement…" : saveStatus === "ok" ? "Enregistré ✓ (confirmé serveur)" : saveStatus === "offline" ? "Pas de connexion !" : saveStatus === "error" ? "Erreur, réessaie" : "Enregistrer"}
              </span>
            </button>
            <button
              onClick={forcerMiseAJour}
              title="Force le rechargement de la dernière version de l'appli"
              className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md border"
              style={{ borderColor: LINE, color: INK_SOFT }}
            >
              <RefreshCw size={13} />
              <span className="hidden sm:inline">Mettre à jour</span>
            </button>
          </div>
        </header>
        <div className="px-5 sm:px-8 py-6">
          {!loaded ? (
            <p className="text-sm" style={{ color: INK_SOFT }}>Chargement des données…</p>
          ) : espaceEnfant && !enfantActifId ? (
            <div className="max-w-md mx-auto text-center pt-8">
              <p className="text-2xl font-serif font-semibold mb-1">👋 Qui es-tu ?</p>
              <p className="text-sm mb-6" style={{ color: INK_SOFT }}>Choisis ton prénom pour voir ton espace.</p>
              <div className="flex flex-col gap-2.5">
                {enfants.map((e) => (
                  <button key={e.id} onClick={() => setEnfantActifId(e.id)}
                    className="py-3 rounded-lg text-lg font-semibold border-2"
                    style={{ borderColor: ACCENTS.enfants.main, color: ACCENTS.enfants.deep, background: ACCENTS.enfants.soft }}>
                    {e.prenom}
                  </button>
                ))}
                {!enfants.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun profil enfant créé — demande à un parent d'en ajouter un dans l'espace complet.</p>}
              </div>
            </div>
          ) : tab === "budget" ? (
            <BudgetTab
              comptes={comptes} setComptes={setComptes}
              transactions={transactions} setTransactions={setTransactions}
              categories={categories} setCategories={setCategories}
              baseMensuelle={baseMensuelle} setBaseMensuelle={setBaseMensuelle}
              budgetQuotidien={budgetQuotidien} setBudgetQuotidien={setBudgetQuotidien}
              decouvert={decouvert} setDecouvert={setDecouvert}
              extrasImprevus={extrasImprevus} setExtrasImprevus={setExtrasImprevus}
              courses={courses} setCourses={setCourses}
              epargnes={epargnes} setEpargnes={setEpargnes}
              accent={ACCENTS.budget}
            />
          ) : tab === "menus" ? (
            <MenusTab menus={menus} setMenus={setMenus} recettes={recettes} setRecettes={setRecettes} accent={ACCENTS.menus}
              menuIdees={menuIdees} setMenuIdees={setMenuIdees} enfants={enfants} />
          ) : tab === "recettes" ? (
            <RecettesTab recettes={recettes} setRecettes={setRecettes} menus={menus} setMenus={setMenus} accent={ACCENTS.recettes} />
          ) : tab === "epargne" ? (
            <EpargneTab epargnes={epargnes} setEpargnes={setEpargnes} accent={ACCENTS.epargne} />
          ) : tab === "enfants" ? (
            <EnfantsTab
              enfants={enfants} setEnfants={setEnfants}
              taches={taches} setTaches={setTaches}
              recompenses={recompenses} setRecompenses={setRecompenses}
              menus={menus} menuIdees={menuIdees} setMenuIdees={setMenuIdees}
              parentPin={parentPin} setParentPin={setParentPin}
              sanctions={sanctions} setSanctions={setSanctions}
              sanctionsPerso={sanctionsPerso} setSanctionsPerso={setSanctionsPerso}
              lecturesSessions={lecturesSessions} setLecturesSessions={setLecturesSessions}
              familyCode={familyCode}
              enfantActifId={espaceEnfant ? enfantActifId : null}
              onChangerProfil={() => setEnfantActifId(null)}
              accent={ACCENTS.enfants}
            />
          ) : tab === "planning" ? (
            <PlanningTab planning={planning} setPlanning={setPlanning} accent={ACCENTS.planning} />
          ) : tab === "todo" ? (
            <TodoTab todos={todos} setTodos={setTodos} accent={ACCENTS.todo} />
          ) : (
            <SportTab
              sportMembres={sportMembres} setSportMembres={setSportMembres}
              mensurations={mensurations} setMensurations={setMensurations}
              seancesSport={seancesSport} setSeancesSport={setSeancesSport}
              exercicesPerso={exercicesPerso} setExercicesPerso={setExercicesPerso}
              nomActif={espaceEnfant ? (enfants.find((e) => e.id === enfantActifId)?.prenom || null) : null}
              onChangerProfil={() => setEnfantActifId(null)}
              accent={ACCENTS.sport}
            />
          )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Petits composants partagés                                          */
/* ------------------------------------------------------------------ */
function Card({ children, className = "", style = {} }) {
  return (
    <div className={`rounded-lg border bg-white/70 p-4 ${className}`} style={{ borderColor: LINE, ...style }}>
      {children}
    </div>
  );
}
function SectionTitle({ children, accent }) {
  return <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: accent.deep }}>{children}</h2>;
}
function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-semibold" style={{ color: INK_SOFT }}>{label}</span>
      {children}
    </label>
  );
}
const inputCls = "border rounded-md px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2";

/* ------------------------------------------------------------------ */
/* BASE MENSUELLE (saisie rapide : charges fixes + salaires)           */
/* ------------------------------------------------------------------ */
const CHECKED_BLUE = "#DCEBFA";
const CHECKED_BLUE_TEXT = "#2C5F8A";

function BaseMensuelleCard({ baseMensuelle, setBaseMensuelle, comptes, accent }) {
  const [form, setForm] = useState({ libelle: "", type: "depense", montant: "", compte: "", jourMois: "" });

  useEffect(() => {
    if (!form.compte && comptes.length) setForm((f) => ({ ...f, compte: comptes[0].nom }));
  }, [comptes]);

  const jourAujourdhui = new Date().getDate();

  // Coche automatiquement toute ligne dont le jour de prélèvement est déjà
  // passé ce mois-ci (et qui n'est pas encore cochée) — à chaque ouverture
  // de l'appli, on "rattrape" les jours qui ont pu s'écouler entre-temps.
  useEffect(() => {
    setBaseMensuelle((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (!l.fait && l.jourMois && Number(l.jourMois) <= jourAujourdhui) {
          changed = true;
          return { ...l, fait: true };
        }
        return l;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLigne = () => {
    if (!form.libelle.trim() || !form.montant) return;
    setBaseMensuelle((prev) => [...prev, { id: uid(), ...form, montant: Number(form.montant), fait: false }]);
    setForm({ ...form, libelle: "", montant: "", jourMois: "" });
  };
  const removeLigne = (id) => setBaseMensuelle((prev) => prev.filter((l) => l.id !== id));
  const toggleLigne = (id) => setBaseMensuelle((prev) => prev.map((l) => (l.id === id ? { ...l, fait: !l.fait } : l)));
  const setJourMoisLigne = (id, jourMois) => setBaseMensuelle((prev) => prev.map((l) => (l.id === id ? { ...l, jourMois: jourMois ? Number(jourMois) : "" } : l)));
  const setMontantLigne = (id, montant) => setBaseMensuelle((prev) => prev.map((l) => (l.id === id ? { ...l, montant: Number(montant) || 0 } : l)));
  const resetTout = () => setBaseMensuelle((prev) => prev.map((l) => ({ ...l, fait: false })));

  const totalDepenses = baseMensuelle.filter((l) => l.type === "depense").reduce((s, l) => s + l.montant, 0);
  const totalRevenus = baseMensuelle.filter((l) => l.type === "revenu").reduce((s, l) => s + l.montant, 0);
  // "Réel à ce jour" : seulement ce qui est vraiment coché comme fait
  const totalRevenusEncaisses = baseMensuelle.filter((l) => l.type === "revenu" && l.fait).reduce((s, l) => s + l.montant, 0);
  const totalDepensesPrelevees = baseMensuelle.filter((l) => l.type === "depense" && l.fait).reduce((s, l) => s + l.montant, 0);

  const [ouvert, setOuvert] = useState(false);

  return (
    <Card>
      <button onClick={() => setOuvert(!ouvert)} className="flex items-center justify-between w-full mb-1 flex-wrap gap-2 text-left">
        <span className="flex items-center gap-2">
          <SectionTitle accent={accent}>Base mensuelle — charges fixes &amp; salaires</SectionTitle>
          <span className="text-xs" style={{ color: INK_SOFT }}>({baseMensuelle.length} lignes · {ouvert ? "cliquer pour replier" : "cliquer pour ouvrir"})</span>
        </span>
        <ChevronDown size={18} style={{ color: INK_SOFT, transform: ouvert ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {!ouvert ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" style={{ color: INK_SOFT }}>
          <span>Revenus fixes : <strong style={{ color: INK }}>{formatEUR(totalRevenus)}</strong></span>
          <span>Charges fixes : <strong style={{ color: INK }}>{formatEUR(totalDepenses)}</strong></span>
        </div>
      ) : (
      <>
      <div className="flex justify-end mb-1">
        <button onClick={resetTout} className="text-xs px-2.5 py-1 rounded-md border font-semibold" style={{ borderColor: LINE, color: INK_SOFT }}>
          Réinitialiser les cases (nouveau mois)
        </button>
      </div>
      <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
        Ta base récurrente : loyer, crédits, abonnements, salaires... Indique le jour du mois où chaque ligne tombe (ex. 5 pour le 5 de chaque mois) — l'appli coche automatiquement dès que ce jour est passé. Tu peux aussi cocher/décocher toi-même à tout moment.
      </p>

      <div className="flex flex-col gap-1 mb-3">
        {/* en-tête */}
        <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-2 text-[11px] font-semibold uppercase tracking-wide px-2" style={{ color: INK_SOFT }}>
          <span className="w-5"></span>
          <span>Libellé</span>
          <span>Compte</span>
          <span>Jour</span>
          <span className="text-right">Montant</span>
          <span></span>
        </div>
        {baseMensuelle.map((l) => {
          const enRetard = l.jourMois && Number(l.jourMois) < jourAujourdhui && !l.fait;
          return (
            <div key={l.id}
              className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-2 items-center px-2 py-2 rounded-md text-sm transition-colors"
              style={{ background: l.fait ? CHECKED_BLUE : "transparent" }}>
              <input type="checkbox" checked={l.fait} onChange={() => toggleLigne(l.id)} className="w-4 h-4" />
              <span className="font-medium flex items-center gap-1.5" style={{ color: l.fait ? CHECKED_BLUE_TEXT : INK }}>
                {l.libelle}
                {enRetard && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F3D6D6", color: "#A33B3B" }}>en retard</span>}
              </span>
              <span className="text-xs" style={{ color: l.fait ? CHECKED_BLUE_TEXT : INK_SOFT }}>{l.compte || "—"}</span>
              <label className="flex items-center gap-1 text-xs" style={{ color: l.fait ? CHECKED_BLUE_TEXT : INK_SOFT }}>
                le
                <input type="number" min="1" max="31" placeholder="j" value={l.jourMois || ""} onChange={(e) => setJourMoisLigne(l.id, e.target.value)}
                  className="w-12 text-center border rounded px-1 py-0.5" style={{ borderColor: LINE, background: l.fait ? "#fff" : "transparent" }} />
              </label>
              <span className="flex items-center gap-1 justify-end" style={{ color: l.fait ? CHECKED_BLUE_TEXT : (l.type === "revenu" ? accent.deep : "#A33B3B") }}>
                {l.type === "revenu" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                <input
                  type="number" step="0.01"
                  defaultValue={l.montant}
                  onBlur={(e) => setMontantLigne(l.id, e.target.value)}
                  className="w-20 text-right font-semibold border rounded px-1 py-0.5 bg-white"
                  style={{ borderColor: LINE, color: "inherit" }}
                />
              </span>
              <button onClick={() => removeLigne(l.id)} className="opacity-40 hover:opacity-100 justify-self-end"><Trash2 size={14} /></button>
            </div>
          );
        })}
        {!baseMensuelle.length && <p className="text-sm px-2" style={{ color: INK_SOFT }}>Aucune ligne pour l'instant — ajoute tes charges fixes et salaires ci-dessous.</p>}
      </div>

      <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
        <Field label="Libellé">
          <input className={inputCls} style={{ borderColor: LINE }} value={form.libelle} onChange={(e) => setForm({ ...form, libelle: e.target.value })} placeholder="Loyer, Salaire, EDF..." />
        </Field>
        <Field label="Type">
          <select className={inputCls} style={{ borderColor: LINE }} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="depense">Dépense</option>
            <option value="revenu">Revenu</option>
          </select>
        </Field>
        <Field label="Compte">
          <select className={inputCls} style={{ borderColor: LINE }} value={form.compte} onChange={(e) => setForm({ ...form, compte: e.target.value })}>
            <option value="">—</option>
            {comptes.map((c) => <option key={c.id} value={c.nom}>{c.nom}</option>)}
          </select>
        </Field>
        <Field label="Jour du prélèvement (1-31)">
          <input type="number" min="1" max="31" className={inputCls + " w-20"} style={{ borderColor: LINE }} value={form.jourMois} onChange={(e) => setForm({ ...form, jourMois: e.target.value })} placeholder="ex. 5" />
        </Field>
        <Field label="Montant (€)">
          <input type="number" step="0.01" className={inputCls + " w-28"} style={{ borderColor: LINE }} value={form.montant} onChange={(e) => setForm({ ...form, montant: e.target.value })} />
        </Field>
        <button onClick={addLigne} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 pt-3 border-t text-sm" style={{ borderColor: LINE }}>
        <span>Total revenus fixes : <strong>{formatEUR(totalRevenus)}</strong></span>
        <span>Total charges fixes : <strong>{formatEUR(totalDepenses)}</strong></span>
        <span>Reste théorique (fin de mois) : <strong>{formatEUR(totalRevenus - totalDepenses)}</strong></span>
        <span>Reçu/prélevé à ce jour : <strong style={{ color: accent.deep }}>{formatEUR(totalRevenusEncaisses - totalDepensesPrelevees)}</strong></span>
      </div>
      </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* BUDGET                                                               */
/* ------------------------------------------------------------------ */
const COULEURS_CAMEMBERT = ["#5F7A5A", "#C17A3B", "#8A4A66", "#4C5B8C", "#C99A2E", "#A33B3B", "#3E7C74"];

function BudgetChartsCard({ totalDepensesFixes, totalQuotidienPrevu, totalCourses, totalExtras, totalImprevus, totalRentrees, epargnes, accent }) {
  const depensesData = [
    { name: "Dépenses fixes", value: totalDepensesFixes },
    { name: "Quotidien (prévu)", value: totalQuotidienPrevu },
    { name: "Courses", value: totalCourses },
    { name: "Extras & imprévus", value: totalExtras + totalImprevus },
  ].filter((d) => d.value > 0);
  const totalDepensesToutes = depensesData.reduce((s, d) => s + d.value, 0);

  const epargneData = epargnes.filter((e) => e.montant > 0).map((e) => ({ name: e.theme, value: e.montant }));
  const totalEpargneToutes = epargneData.reduce((s, d) => s + d.value, 0);

  const revenusDepensesData = [
    { name: "Rentrées", montant: totalRentrees },
    { name: "Dépenses", montant: totalDepensesToutes },
  ];

  const renderLabel = ({ percent }) => `${Math.round(percent * 100)}%`;

  return (
    <div className="grid md:grid-cols-3 gap-6">
      <Card>
        <SectionTitle accent={accent}>Répartition des dépenses</SectionTitle>
        {depensesData.length ? (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={depensesData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={renderLabel}>
                  {depensesData.map((_, i) => <Cell key={i} fill={COULEURS_CAMEMBERT[i % COULEURS_CAMEMBERT.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => formatEUR(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-col gap-1 mt-2 text-xs">
              {depensesData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: COULEURS_CAMEMBERT[i % COULEURS_CAMEMBERT.length] }} />{d.name}</span>
                  <span className="font-semibold">{formatEUR(d.value)}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm" style={{ color: INK_SOFT }}>Pas encore assez de données ce mois-ci.</p>
        )}
      </Card>

      <Card>
        <SectionTitle accent={accent}>Répartition de l'épargne</SectionTitle>
        {epargneData.length ? (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={epargneData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={renderLabel}>
                  {epargneData.map((_, i) => <Cell key={i} fill={COULEURS_CAMEMBERT[(i + 2) % COULEURS_CAMEMBERT.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => formatEUR(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-col gap-1 mt-2 text-xs">
              {epargneData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: COULEURS_CAMEMBERT[(i + 2) % COULEURS_CAMEMBERT.length] }} />{d.name}</span>
                  <span className="font-semibold">{formatEUR(d.value)}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm" style={{ color: INK_SOFT }}>Aucune épargne enregistrée pour l'instant.</p>
        )}
      </Card>

      <Card>
        <SectionTitle accent={accent}>Rentrées vs dépenses</SectionTitle>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={revenusDepensesData}>
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatEUR(v)} />
            <Bar dataKey="montant" radius={[6, 6, 0, 0]}>
              {revenusDepensesData.map((d, i) => <Cell key={i} fill={i === 0 ? accent.main : "#A33B3B"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="text-xs mt-2 text-center" style={{ color: totalRentrees - totalDepensesToutes < 0 ? "#A33B3B" : accent.deep }}>
          {totalRentrees - totalDepensesToutes >= 0 ? "Excédent" : "Déficit"} : <strong>{formatEUR(Math.abs(totalRentrees - totalDepensesToutes))}</strong>
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* BUDGET                                                               */
/* ------------------------------------------------------------------ */
function BudgetTab({ comptes, setComptes, transactions, setTransactions, categories, setCategories, baseMensuelle, setBaseMensuelle, budgetQuotidien, setBudgetQuotidien, decouvert, setDecouvert, extrasImprevus, setExtrasImprevus, courses, setCourses, epargnes, setEpargnes, accent }) {

  const [newCompte, setNewCompte] = useState("");
  const [newSolde, setNewSolde] = useState("0");
  const [form, setForm] = useState({ date: todayISO(), compte: "", categorie: categories[0] || "", type: "depense", montant: "", description: "", interne: false, realisee: true });
  const [newCat, setNewCat] = useState("");
  const [monthFilter, setMonthFilter] = useState(todayISO().slice(0, 7));

  // --- Suivi avancé (basé sur le fichier Excel d'origine) ---
  const [quotForm, setQuotForm] = useState({ categorie: "", prevu: "" });
  const [depenseRapide, setDepenseRapide] = useState({});
  const [courseForm, setCourseForm] = useState({ achat: "", montant: "" });
  const [extraForm, setExtraForm] = useState({ poste: "", montant: "", type: "extra" });

  const importerDonneesExcel = () => {
    if (!window.confirm("Importer les données de ton fichier Excel ? Ça ajoute des lignes à ta Base mensuelle, ton Quotidien et ton Épargne (ça ne supprime rien de ce qui existe déjà).")) return;

    const nouvellesBase = [
      // Rentrées d'argent
      { id: uid(), libelle: "xefi", type: "revenu", compte: "", montant: 2123, fait: false },
      { id: uid(), libelle: "MIHI", type: "revenu", compte: "", montant: 1450, fait: false },
      { id: uid(), libelle: "CAF", type: "revenu", compte: "", montant: 1475, fait: false },
      { id: uid(), libelle: "frais", type: "revenu", compte: "", montant: 464, fait: false },
      // Dépenses fixes
      { id: uid(), libelle: "Loyer", type: "depense", compte: "", montant: 840, fait: false },
      { id: uid(), libelle: "Eau", type: "depense", compte: "", montant: 42.86, fait: false },
      { id: uid(), libelle: "L'abeille", type: "depense", compte: "", montant: 220, fait: false },
      { id: uid(), libelle: "Urssaf", type: "depense", compte: "", montant: 150, fait: false },
      { id: uid(), libelle: "Canva", type: "depense", compte: "", montant: 12, fait: false },
      { id: uid(), libelle: "fin", type: "depense", compte: "", montant: 108, fait: false },
      { id: uid(), libelle: "Free", type: "depense", compte: "", montant: 69.96, fait: false },
      { id: uid(), libelle: "Macif assurance", type: "depense", compte: "", montant: 211, fait: false },
      { id: uid(), libelle: "Volvo", type: "depense", compte: "", montant: 568, fait: false },
      { id: uid(), libelle: "Octopus énergie", type: "depense", compte: "", montant: 333, fait: false },
      { id: uid(), libelle: "AREA", type: "depense", compte: "", montant: 150, fait: false },
      { id: uid(), libelle: "Spotify", type: "depense", compte: "", montant: 17, fait: false },
      { id: uid(), libelle: "Mutuelle", type: "depense", compte: "", montant: 38, fait: false },
      { id: uid(), libelle: "Free mobile", type: "depense", compte: "", montant: 24, fait: false },
      { id: uid(), libelle: "Cantine Tim", type: "depense", compte: "", montant: 61, fait: false },
      { id: uid(), libelle: "Internat", type: "depense", compte: "", montant: 365, fait: false },
      { id: uid(), libelle: "École", type: "depense", compte: "", montant: 63, fait: false },
      { id: uid(), libelle: "Oze", type: "depense", compte: "", montant: 35, fait: false },
      { id: uid(), libelle: "Stas", type: "depense", compte: "", montant: 9.56, fait: false },
      { id: uid(), libelle: "Trampoline", type: "depense", compte: "", montant: 50, fait: false },
      { id: uid(), libelle: "Claude", type: "depense", compte: "", montant: 90, fait: false },
      { id: uid(), libelle: "cantine élémentaire", type: "depense", compte: "", montant: 40, fait: false },
    ];
    setBaseMensuelle((prev) => [...prev, ...nouvellesBase]);

    setBudgetQuotidien((prev) => [...prev,
      { id: uid(), categorie: "Alimentation", prevu: 1100 },
      { id: uid(), categorie: "Essence", prevu: 500 },
      { id: uid(), categorie: "epilation", prevu: 25 },
    ]);

    setEpargnes((prev) => [...prev,
      { id: uid(), theme: "Timéo", objectif: 300, montant: 300 },
      { id: uid(), theme: "Léoni", objectif: 264, montant: 264 },
      { id: uid(), theme: "Leandro", objectif: 240, montant: 240 },
    ]);

    setCourses((prev) => [...prev,
      { id: uid(), achat: "Courses", montant: 365, date: todayISO() },
      { id: uid(), achat: "courses", montant: 249, date: todayISO() },
      { id: uid(), achat: "spart (courses)", montant: 66, date: todayISO() },
    ]);

    setExtrasImprevus((prev) => [...prev,
      { id: uid(), poste: "tatoo", montant: 180, type: "extra", date: todayISO() },
      { id: uid(), poste: "running", montant: 190, type: "extra", date: todayISO() },
      { id: uid(), poste: "resto", montant: 228, type: "extra", date: todayISO() },
      { id: uid(), poste: "boucherie", montant: 24, type: "extra", date: todayISO() },
      { id: uid(), poste: "action", montant: 130, type: "extra", date: todayISO() },
      { id: uid(), poste: "transport", montant: 320, type: "extra", date: todayISO() },
    ]);
  };

  useEffect(() => {
    if (!form.compte && comptes.length) setForm((f) => ({ ...f, compte: comptes[0].nom }));
  }, [comptes]);

  const soldeCompte = (nomCompte) => {
    const c = comptes.find((c) => c.nom === nomCompte);
    const base = c ? Number(c.solde) || 0 : 0;
    const delta = transactions
      .filter((t) => t.compte === nomCompte && t.realisee !== false) // ne compte que si coché comme "réalisée"
      .reduce((s, t) => s + (t.type === "revenu" ? Number(t.montant) : -Number(t.montant)), 0);
    return base + delta;
  };
  const soldeTotal = comptes.reduce((s, c) => s + soldeCompte(c.nom), 0);
  const transactionsNonRealisees = transactions.filter((t) => t.realisee === false);
  const toggleRealisee = (id) => setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, realisee: t.realisee === false } : t)));

  const addCompte = () => {
    if (!newCompte.trim()) return;
    setComptes((prev) => [...prev, { id: uid(), nom: newCompte.trim(), solde: Number(newSolde) || 0 }]);
    setNewCompte(""); setNewSolde("0");
  };
  const removeCompte = (id) => {
    const c = comptes.find((c) => c.id === id);
    setComptes((prev) => prev.filter((c) => c.id !== id));
    if (c) setTransactions((prev) => prev.filter((t) => t.compte !== c.nom));
  };
  const updateSoldeCompte = (id, solde) => {
    setComptes((prev) => prev.map((c) => (c.id === id ? { ...c, solde: Number(solde) || 0 } : c)));
  };
  const addTransaction = () => {
    if (!form.compte || !form.montant) return;
    setTransactions((prev) => [{ id: uid(), ...form, montant: Number(form.montant) }, ...prev]);
    setForm({ ...form, montant: "", description: "" });
  };
  const removeTransaction = (id) => setTransactions((prev) => prev.filter((t) => t.id !== id));
  const addCategorie = () => {
    if (!newCat.trim() || categories.includes(newCat.trim())) return;
    setCategories((prev) => [...prev, newCat.trim()]);
    setNewCat("");
  };

  const monthTx = transactions.filter((t) => t.date.slice(0, 7) === monthFilter && !t.interne);
  const parCategorie = useMemo(() => {
    const map = {};
    monthTx.filter((t) => t.type === "depense").forEach((t) => { map[t.categorie] = (map[t.categorie] || 0) + Number(t.montant); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [monthTx]);
  const maxCat = Math.max(1, ...parCategorie.map(([, v]) => v));

  // --- Le Quotidien : budget prévu par catégorie ---
  const addQuot = () => {
    if (!quotForm.categorie.trim() || !quotForm.prevu) return;
    setBudgetQuotidien((prev) => [...prev, { id: uid(), categorie: quotForm.categorie.trim(), prevu: Number(quotForm.prevu) || 0 }]);
    setQuotForm({ categorie: "", prevu: "" });
  };
  const removeQuot = (id) => setBudgetQuotidien((prev) => prev.filter((q) => q.id !== id));
  const setPrevuQuot = (id, prevu) => setBudgetQuotidien((prev) => prev.map((q) => (q.id === id ? { ...q, prevu: Number(prevu) || 0 } : q)));
  const ajouterDepenseRapide = (q) => {
    const montant = Number(depenseRapide[q.id] || 0);
    if (!montant) return;
    setTransactions((prev) => [{
      id: uid(), date: todayISO(), compte: comptes[0]?.nom || "", categorie: q.categorie,
      type: "depense", montant, description: "",
    }, ...prev]);
    setDepenseRapide({ ...depenseRapide, [q.id]: "" });
  };

  const reelParCategorieMapBrute = Object.fromEntries(parCategorie);
  // Les courses saisies dans "Suivi courses" comptent comme du réel pour la catégorie Alimentation
  const totalCoursesAnticipe = courses.reduce((s, c) => s + c.montant, 0);
  const reelParCategorieMap = Object.fromEntries(
    budgetQuotidien.map((q) => [
      q.categorie,
      (reelParCategorieMapBrute[q.categorie] || 0) + (q.categorie.toLowerCase().includes("aliment") ? totalCoursesAnticipe : 0),
    ])
  );
  const totalQuotidienPrevu = budgetQuotidien.reduce((s, q) => s + q.prevu, 0);
  const totalQuotidienReel = budgetQuotidien.reduce((s, q) => s + (reelParCategorieMap[q.categorie] || 0), 0);

  // --- Suivi du découvert ---
  const decouvertRestant = Math.max(0, (decouvert.debutMois || 0) - (decouvert.rembourseCeMois || 0));

  // --- Suivi courses (cumul) ---
  const addCourse = () => {
    if (!courseForm.achat.trim() || !courseForm.montant) return;
    setCourses((prev) => [{ id: uid(), achat: courseForm.achat.trim(), montant: Number(courseForm.montant) || 0, date: todayISO() }, ...prev]);
    setCourseForm({ achat: "", montant: "" });
  };
  const removeCourse = (id) => setCourses((prev) => prev.filter((c) => c.id !== id));
  const totalCourses = totalCoursesAnticipe;
  const budgetAlimentation = budgetQuotidien.find((q) => q.categorie.toLowerCase().includes("aliment"))?.prevu || 0;
  const resteDisponibleCourses = budgetAlimentation - totalCourses;

  // --- Extras & imprévus hors budget ---
  const addExtra = () => {
    if (!extraForm.poste.trim() || !extraForm.montant) return;
    setExtrasImprevus([{ id: uid(), poste: extraForm.poste.trim(), montant: Number(extraForm.montant) || 0, type: extraForm.type, date: todayISO() }, ...extrasImprevus]);
    setExtraForm({ poste: "", montant: "", type: "extra" });
  };
  const removeExtra = (id) => setExtrasImprevus((prev) => prev.filter((e) => e.id !== id));
  const totalExtras = extrasImprevus.filter((e) => e.type === "extra").reduce((s, e) => s + e.montant, 0);
  const totalImprevus = extrasImprevus.filter((e) => e.type === "imprevu").reduce((s, e) => s + e.montant, 0);

  // --- Vue d'ensemble (mêmes formules que le fichier Excel d'origine) ---
  const revenusTransactionsCeMoisVE = monthTx.filter((t) => t.type === "revenu").reduce((s, t) => s + Number(t.montant), 0);
  const totalRentrees = baseMensuelle.filter((l) => l.type === "revenu").reduce((s, l) => s + l.montant, 0) + revenusTransactionsCeMoisVE;
  const totalDepensesFixes = baseMensuelle.filter((l) => l.type === "depense").reduce((s, l) => s + l.montant, 0);
  const resteTheorique = totalRentrees - totalDepensesFixes - totalQuotidienPrevu;
  const resteReelApresDecouvert = resteTheorique - (decouvert.rembourseCeMois || 0);
  const resteDisponibleGlobal = resteReelApresDecouvert - totalExtras - totalImprevus;
  // Où j'en suis VRAIMENT à ce jour : ce qui est coché comme reçu/prélevé
  // (Base mensuelle) + TOUTES les transactions ponctuelles du mois
  // (revenus et dépenses saisis dans "Nouvelle transaction") + courses/extras/imprévus.
  const totalRevenusEncaisses = baseMensuelle.filter((l) => l.type === "revenu" && l.fait).reduce((s, l) => s + l.montant, 0);
  const totalDepensesPreleveesGlobal = baseMensuelle.filter((l) => l.type === "depense" && l.fait).reduce((s, l) => s + l.montant, 0);
  const revenusTransactionsCeMois = monthTx.filter((t) => t.type === "revenu").reduce((s, t) => s + Number(t.montant), 0);
  const depensesTransactionsCeMois = monthTx.filter((t) => t.type === "depense").reduce((s, t) => s + Number(t.montant), 0);
  const soldeReelAJour = (totalRevenusEncaisses + revenusTransactionsCeMois) - (totalDepensesPreleveesGlobal + depensesTransactionsCeMois) - totalCourses - totalExtras - totalImprevus;

  const handleCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = Papa.parse(ev.target.result, { header: true, skipEmptyLines: true });
      const find = (row, keys) => {
        const k = Object.keys(row).find((k) => keys.some((needle) => k.toLowerCase().includes(needle)));
        return k ? row[k] : "";
      };
      const nouvelles = [];
      const comptesVus = new Set(comptes.map((c) => c.nom));
      parsed.data.forEach((row) => {
        const dateRaw = find(row, ["date"]);
        const compteRaw = find(row, ["compte", "account"]) || "Compte importé";
        const catRaw = find(row, ["categ"]) || "Autres";
        const montantRaw = find(row, ["montant", "amount"]);
        const typeRaw = (find(row, ["type"]) || "").toLowerCase();
        const descRaw = find(row, ["desc", "libell"]);
        if (!montantRaw) return;
        let montant = Number(String(montantRaw).replace(",", ".").replace(/[^0-9.-]/g, ""));
        let type = typeRaw.includes("rev") ? "revenu" : "depense";
        if (montant < 0) { type = "depense"; montant = Math.abs(montant); }
        let date = dateRaw;
        if (date && date.includes("/")) { const [j, m, a] = date.split("/"); date = `${a.length === 2 ? "20" + a : a}-${m.padStart(2, "0")}-${j.padStart(2, "0")}`; }
        if (!date) date = todayISO();
        comptesVus.add(compteRaw);
        nouvelles.push({ id: uid(), date, compte: compteRaw, categorie: catRaw, type, montant, description: descRaw || "" });
      });
      const comptesManquants = [...comptesVus].filter((n) => !comptes.some((c) => c.nom === n)).map((n) => ({ id: uid(), nom: n, solde: 0 }));
      if (comptesManquants.length) setComptes((prev) => [...prev, ...comptesManquants]);
      setTransactions((prev) => [...nouvelles, ...prev]);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div className="flex justify-end">
        <button onClick={importerDonneesExcel} className="text-xs px-3 py-1.5 rounded-md font-semibold border flex items-center gap-1.5" style={{ borderColor: LINE, color: accent.deep }}>
          <Upload size={13} />Importer mes données de départ (fichier Excel)
        </button>
      </div>
      {/* Solde global */}
      <div className="rounded-lg p-5 flex flex-wrap gap-6 items-center" style={{ background: accent.soft }}>
        <div>
          <p className="text-xs uppercase tracking-wide font-semibold" style={{ color: accent.deep }}>Solde total</p>
          <p className="text-3xl font-serif font-bold" style={{ color: accent.deep }}>{formatEUR(soldeTotal)}</p>
          {!!transactionsNonRealisees.length && (
            <p className="text-[11px] mt-1" style={{ color: INK_SOFT }}>
              {transactionsNonRealisees.length} transaction{transactionsNonRealisees.length > 1 ? "s" : ""} pas encore réalisée{transactionsNonRealisees.length > 1 ? "s" : ""}, pas comptée{transactionsNonRealisees.length > 1 ? "s" : ""} ici
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          {comptes.map((c) => (
            <div key={c.id} className="text-sm">
              <p className="font-semibold">{c.nom}</p>
              <p style={{ color: soldeCompte(c.nom) < 0 ? "#A33B3B" : INK_SOFT }}>{formatEUR(soldeCompte(c.nom))}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Vue d'ensemble */}
      <div className="rounded-lg p-5" style={{ background: accent.soft }}>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <p className="text-xs uppercase tracking-wide font-semibold" style={{ color: accent.deep }}>Vue d'ensemble du mois</p>
          <label className="text-xs flex items-center gap-1.5" style={{ color: INK_SOFT }}>
            Mois analysé :
            <input type="month" className="border rounded-md px-2 py-1 bg-white text-xs" style={{ borderColor: LINE }} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
          </label>
        </div>
        <p className="text-[11px] mb-2" style={{ color: INK_SOFT }}>
          "Rentrées" et "Où j'en suis vraiment" ne comptent que les transactions dont la date tombe dans ce mois-là — si une transaction n'apparaît pas, vérifie sa date.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><p style={{ color: INK_SOFT }}>Rentrées</p><p className="font-serif font-bold text-lg">{formatEUR(totalRentrees)}</p></div>
          <div><p style={{ color: INK_SOFT }}>Dépenses fixes</p><p className="font-serif font-bold text-lg">{formatEUR(totalDepensesFixes)}</p></div>
          <div><p style={{ color: INK_SOFT }}>Quotidien prévu</p><p className="font-serif font-bold text-lg">{formatEUR(totalQuotidienPrevu)}</p></div>
          <div><p style={{ color: INK_SOFT }}>Reste disponible en fin de mois (théorique)</p><p className="font-serif font-bold text-lg" style={{ color: resteDisponibleGlobal < 0 ? "#A33B3B" : accent.deep }}>{formatEUR(resteDisponibleGlobal)}</p></div>
        </div>
        <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
          <p style={{ color: INK_SOFT }} className="text-sm">Où j'en suis <strong>vraiment</strong> à ce jour (uniquement ce qui est coché comme reçu/prélevé + courses/extras déjà engagés) :</p>
          <p className="font-serif font-bold text-2xl" style={{ color: soldeReelAJour < 0 ? "#A33B3B" : accent.deep }}>{formatEUR(soldeReelAJour)}</p>
        </div>
      </div>

      <BudgetChartsCard
        totalDepensesFixes={totalDepensesFixes}
        totalQuotidienPrevu={totalQuotidienPrevu}
        totalCourses={totalCourses}
        totalExtras={totalExtras}
        totalImprevus={totalImprevus}
        totalRentrees={totalRentrees}
        epargnes={epargnes}
        accent={accent}
      />

      {/* Comptes */}
      <Card>
        <SectionTitle accent={accent}>Comptes</SectionTitle>
        <div className="flex flex-col gap-1.5 mb-3">
          {comptes.map((c) => (
            <div key={c.id} className="flex items-center gap-2 flex-wrap px-2.5 py-1.5 rounded-md" style={{ background: accent.soft }}>
              <span className="font-medium text-sm flex-1 min-w-[100px]" style={{ color: accent.deep }}>{c.nom}</span>
              <label className="flex items-center gap-1.5 text-xs" style={{ color: INK_SOFT }}>
                Solde initial
                <input
                  type="number" step="0.01"
                  defaultValue={c.solde}
                  onBlur={(e) => updateSoldeCompte(c.id, e.target.value)}
                  className="border rounded-md px-2 py-1 text-sm w-24 bg-white"
                  style={{ borderColor: LINE }}
                />
              </label>
              <button onClick={() => removeCompte(c.id)} className="opacity-50 hover:opacity-100"><X size={15} /></button>
            </div>
          ))}
          {!comptes.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun compte pour le moment — ajoute ton premier compte.</p>}
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <Field label="Nom du compte">
            <input className={inputCls} style={{ borderColor: LINE }} value={newCompte} onChange={(e) => setNewCompte(e.target.value)} placeholder="Compte courant" />
          </Field>
          <Field label="Solde initial">
            <input type="number" className={inputCls + " w-32"} style={{ borderColor: LINE }} value={newSolde} onChange={(e) => setNewSolde(e.target.value)} />
          </Field>
          <button onClick={addCompte} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
        </div>
      </Card>

      <BaseMensuelleCard
        baseMensuelle={baseMensuelle} setBaseMensuelle={setBaseMensuelle}
        comptes={comptes} accent={accent}
      />

      {/* Nouvelle transaction */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionTitle accent={accent}>Nouvelle transaction</SectionTitle>
          <label className="text-xs font-semibold flex items-center gap-1.5 cursor-pointer px-2.5 py-1.5 rounded-md border" style={{ borderColor: LINE, color: accent.deep }}>
            <Upload size={14} /> Importer un CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleCSV} />
          </label>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 items-end">
          <Field label="Date">
            <input type="date" className={inputCls} style={{ borderColor: LINE }} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Compte">
            <select className={inputCls} style={{ borderColor: LINE }} value={form.compte} onChange={(e) => setForm({ ...form, compte: e.target.value })}>
              {comptes.map((c) => <option key={c.id} value={c.nom}>{c.nom}</option>)}
            </select>
          </Field>
          <Field label="Catégorie">
            <select className={inputCls} style={{ borderColor: LINE }} value={form.categorie} onChange={(e) => setForm({ ...form, categorie: e.target.value })}>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className={inputCls} style={{ borderColor: LINE }} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="depense">Dépense</option>
              <option value="revenu">Revenu</option>
            </select>
          </Field>
          <Field label="Montant (€)">
            <input type="number" step="0.01" className={inputCls} style={{ borderColor: LINE }} value={form.montant} onChange={(e) => setForm({ ...form, montant: e.target.value })} />
          </Field>
          <Field label="Description">
            <input className={inputCls} style={{ borderColor: LINE }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optionnel" />
          </Field>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: INK_SOFT }}>
            <input type="checkbox" checked={form.realisee} onChange={(e) => setForm({ ...form, realisee: e.target.checked })} className="w-4 h-4" />
            Déjà réalisée (compte dans le solde) — décoche si c'est juste prévu pour plus tard
          </label>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: INK_SOFT }}>
            <input type="checkbox" checked={form.interne} onChange={(e) => setForm({ ...form, interne: e.target.checked })} className="w-4 h-4" />
            Virement interne (épargne ↔ compte...) — affecte le solde du compte mais pas "Rentrées"/l'équilibre revenus-dépenses
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input className={inputCls + " flex-1 max-w-[180px]"} style={{ borderColor: LINE }} placeholder="Nouvelle catégorie" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button onClick={addCategorie} className="text-xs px-2.5 py-1.5 rounded-md border font-semibold" style={{ borderColor: LINE, color: accent.deep }}>+ Catégorie</button>
          <div className="flex-1" />
          <button onClick={addTransaction} disabled={!comptes.length} className="h-9 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-40" style={{ background: accent.main }}><Plus size={15} />Enregistrer</button>
        </div>
      </Card>

      {/* Répartition + historique */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-1">
            <SectionTitle accent={accent}>Répartition par catégorie</SectionTitle>
            <input type="month" className="text-xs border rounded-md px-2 py-1" style={{ borderColor: LINE }} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
          </div>
          <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
            Calculé automatiquement à partir de tes dépenses saisies dans "Nouvelle transaction" ci-dessus (par catégorie). Rien à remplir ici — c'est juste un résumé visuel.
          </p>
          <div className="flex flex-col gap-2">
            {parCategorie.map(([cat, val]) => (
              <div key={cat}>
                <div className="flex justify-between text-xs mb-0.5"><span className="font-medium">{cat}</span><span>{formatEUR(val)}</span></div>
                <div className="h-2 rounded-full bg-black/5"><div className="h-2 rounded-full" style={{ width: `${(val / maxCat) * 100}%`, background: accent.main }} /></div>
              </div>
            ))}
            {!parCategorie.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune dépense ce mois-ci.</p>}
          </div>
        </Card>
        <Card>
          <SectionTitle accent={accent}>Historique récent</SectionTitle>
          <div className="flex flex-col gap-1.5 max-h-72 overflow-auto pr-1">
            {transactions.slice(0, 40).map((t) => {
              const nonRealisee = t.realisee === false;
              return (
              <div key={t.id} className="flex items-center justify-between text-sm py-1.5 border-b px-1 rounded" style={{ borderColor: LINE, background: nonRealisee ? "#FCEFD9" : "transparent" }}>
                <label className="flex items-start gap-2 min-w-0 cursor-pointer">
                  <input type="checkbox" checked={!nonRealisee} onChange={() => toggleRealisee(t.id)} className="w-4 h-4 mt-0.5 shrink-0" title="Décoche si ce n'est pas encore réalisé" />
                  <div className="min-w-0">
                    <p className="truncate font-medium flex items-center gap-1.5">
                      {t.description || t.categorie}
                      {t.interne && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: accent.soft, color: accent.deep }}>virement interne</span>}
                      {nonRealisee && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "#F0C36B", color: "#5C4300" }}>pas encore réalisée</span>}
                    </p>
                    <p className="text-xs" style={{ color: INK_SOFT }}>{t.date} · {t.compte} · {t.categorie}</p>
                  </div>
                </label>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-semibold flex items-center gap-1" style={{ color: t.type === "revenu" ? accent.deep : "#A33B3B" }}>
                    {t.type === "revenu" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {formatEUR(t.montant)}
                  </span>
                  <button onClick={() => removeTransaction(t.id)} className="opacity-40 hover:opacity-100"><Trash2 size={14} /></button>
                </div>
              </div>
              );
            })}
            {!transactions.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune transaction pour le moment.</p>}
          </div>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Le Quotidien : budget prévu vs réel */}
        <Card>
          <SectionTitle accent={accent}>Le Quotidien — prévu vs réel</SectionTitle>
          <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
            Le "réel" se remplit soit via "Courses" ci-dessous (pour Alimentation), soit directement ici avec le "+" sur chaque ligne.
          </p>
          <div className="flex flex-col gap-2 mb-3">
            {budgetQuotidien.map((q) => {
              const reel = reelParCategorieMap[q.categorie] || 0;
              const reste = q.prevu - reel;
              return (
                <div key={q.id} className="text-sm">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="font-medium">{q.categorie}</span>
                    <div className="flex items-center gap-2">
                      <span style={{ color: INK_SOFT }} className="flex items-center gap-1">
                        {formatEUR(reel)} /
                        <input
                          type="number" step="0.01"
                          defaultValue={q.prevu}
                          onBlur={(e) => setPrevuQuot(q.id, e.target.value)}
                          className="w-16 text-right border rounded px-1 py-0.5 bg-white"
                          style={{ borderColor: LINE }}
                        /> €
                      </span>
                      <button onClick={() => removeQuot(q.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-black/5"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, (reel / (q.prevu || 1)) * 100)}%`, background: reste < 0 ? "#A33B3B" : accent.main }} /></div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p style={{ color: reste < 0 ? "#A33B3B" : INK_SOFT }}>reste {formatEUR(reste)}</p>
                    <div className="flex items-center gap-1">
                      <input
                        type="number" step="0.01" placeholder="Montant dépensé"
                        value={depenseRapide[q.id] || ""}
                        onChange={(e) => setDepenseRapide({ ...depenseRapide, [q.id]: e.target.value })}
                        className="w-24 text-right border rounded px-1.5 py-0.5 bg-white text-xs"
                        style={{ borderColor: LINE }}
                      />
                      <button
                        onClick={() => ajouterDepenseRapide(q)}
                        className="text-xs px-2 py-0.5 rounded-md font-semibold text-white flex items-center gap-0.5"
                        style={{ background: accent.main }}
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {!budgetQuotidien.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune catégorie budgétée pour l'instant.</p>}
          </div>
          <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
            <Field label="Catégorie">
              <input className={inputCls} style={{ borderColor: LINE }} value={quotForm.categorie} onChange={(e) => setQuotForm({ ...quotForm, categorie: e.target.value })} placeholder="Alimentation" />
            </Field>
            <Field label="Prévu (€)">
              <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={quotForm.prevu} onChange={(e) => setQuotForm({ ...quotForm, prevu: e.target.value })} />
            </Field>
            <button onClick={addQuot} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
          </div>
        </Card>

        {/* Suivi du découvert */}
        <Card>
          <SectionTitle accent={accent}>Suivi du découvert</SectionTitle>
          <div className="flex flex-wrap gap-3 mb-3">
            <Field label="Découvert en début de mois">
              <input type="number" className={inputCls + " w-32"} style={{ borderColor: LINE }} value={decouvert.debutMois || ""} onChange={(e) => setDecouvert({ ...decouvert, debutMois: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Remboursé ce mois-ci">
              <input type="number" className={inputCls + " w-32"} style={{ borderColor: LINE }} value={decouvert.rembourseCeMois || ""} onChange={(e) => setDecouvert({ ...decouvert, rembourseCeMois: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          <p className="text-sm">Découvert restant : <strong style={{ color: decouvertRestant > 0 ? "#A33B3B" : accent.deep }}>{formatEUR(decouvertRestant)}</strong></p>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Suivi courses */}
        <Card>
          <SectionTitle accent={accent}>Suivi courses (cumul)</SectionTitle>
          <p className="text-sm mb-2">Total : <strong>{formatEUR(totalCourses)}</strong>{budgetAlimentation > 0 && <> · reste disponible <strong style={{ color: resteDisponibleCourses < 0 ? "#A33B3B" : accent.deep }}>{formatEUR(resteDisponibleCourses)}</strong></>}</p>
          <div className="flex flex-col gap-1.5 mb-3 max-h-48 overflow-auto pr-1">
            {courses.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-sm py-1 border-b" style={{ borderColor: LINE }}>
                <span>{c.achat}</span>
                <div className="flex items-center gap-2"><span className="font-semibold">{formatEUR(c.montant)}</span><button onClick={() => removeCourse(c.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button></div>
              </div>
            ))}
            {!courses.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun achat enregistré.</p>}
          </div>
          <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
            <Field label="Achat">
              <input className={inputCls} style={{ borderColor: LINE }} value={courseForm.achat} onChange={(e) => setCourseForm({ ...courseForm, achat: e.target.value })} placeholder="Courses, boucherie..." />
            </Field>
            <Field label="Montant (€)">
              <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={courseForm.montant} onChange={(e) => setCourseForm({ ...courseForm, montant: e.target.value })} />
            </Field>
            <button onClick={addCourse} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
          </div>
        </Card>

        {/* Extras & imprévus */}
        <Card>
          <SectionTitle accent={accent}>Extras &amp; imprévus (hors budget)</SectionTitle>
          <p className="text-sm mb-2">Extras : <strong>{formatEUR(totalExtras)}</strong> · Imprévus : <strong>{formatEUR(totalImprevus)}</strong></p>
          <div className="flex flex-col gap-1.5 mb-3 max-h-48 overflow-auto pr-1">
            {extrasImprevus.map((e) => (
              <div key={e.id} className="flex items-center justify-between text-sm py-1 border-b" style={{ borderColor: LINE }}>
                <span>{e.poste} <span className="text-xs px-1.5 py-0.5 rounded-full ml-1" style={{ background: accent.soft, color: accent.deep }}>{e.type === "extra" ? "extra" : "imprévu"}</span></span>
                <div className="flex items-center gap-2"><span className="font-semibold">{formatEUR(e.montant)}</span><button onClick={() => removeExtra(e.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button></div>
              </div>
            ))}
            {!extrasImprevus.length && <p className="text-sm" style={{ color: INK_SOFT }}>Rien d'enregistré pour l'instant.</p>}
          </div>
          <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
            <Field label="Poste">
              <input className={inputCls} style={{ borderColor: LINE }} value={extraForm.poste} onChange={(e) => setExtraForm({ ...extraForm, poste: e.target.value })} placeholder="Resto, tatoo, réparation..." />
            </Field>
            <Field label="Type">
              <select className={inputCls} style={{ borderColor: LINE }} value={extraForm.type} onChange={(e) => setExtraForm({ ...extraForm, type: e.target.value })}>
                <option value="extra">Extra</option>
                <option value="imprevu">Imprévu</option>
              </select>
            </Field>
            <Field label="Montant (€)">
              <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={extraForm.montant} onChange={(e) => setExtraForm({ ...extraForm, montant: e.target.value })} />
            </Field>
            <button onClick={addExtra} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
          </div>
        </Card>
      </div>
    </div>
  );
}

const MOMENT_LABELS = { midi: "Midi", gouter: "Goûter", soir: "Soir" };

const MOMENT_ICONS = { midi: Sun, gouter: Cookie, soir: Moon };

function MomentRow({ label, date, moment, types, getEntry, setEntry, recettes, accent, single }) {
  const Icon = MOMENT_ICONS[moment] || Sun;
  const dejaSepare = !single && types.some((type) => getEntry(date, moment, type, "enfants") || getEntry(date, moment, type, "parents"));
  const [separe, setSepare] = useState(dejaSepare);

  const champs = (pub) => (
    <div className={`grid gap-3 ${single ? "grid-cols-1 max-w-xs" : "grid-cols-1 sm:grid-cols-3"}`}>
      {types.map((type) => {
        const entry = getEntry(date, moment, type, pub);
        const listId = `list-${moment}-${type}-${pub}`;
        return (
          <div key={type}>
            {!single && <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: INK_SOFT }}>{type}</p>}
            <input
              list={listId}
              className="w-full border rounded-md px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: LINE }}
              defaultValue={entry ? entry.nom : ""}
              placeholder="—"
              onBlur={(e) => setEntry(date, moment, type, e.target.value, pub)}
            />
            <datalist id={listId}>
              {recettes.filter((r) => r.type === type).map((r) => <option key={r.id} value={r.nom} />)}
            </datalist>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="rounded-lg p-3.5" style={{ background: accent.soft }}>
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <p className="text-xs font-bold uppercase tracking-wide flex items-center gap-1.5" style={{ color: accent.deep }}>
          <Icon size={15} />{label}
        </p>
        {!single && (
          <button onClick={() => setSepare(!separe)} className="text-[10px] font-semibold underline" style={{ color: accent.deep }}>
            {separe ? "revenir à un seul plat" : "plat différent enfants / parents"}
          </button>
        )}
      </div>
      {separe && !single ? (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide mb-1.5" style={{ color: INK_SOFT }}>Parents</p>
            {champs("parents")}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide mb-1.5" style={{ color: INK_SOFT }}>Enfants</p>
            {champs("enfants")}
          </div>
        </div>
      ) : (
        champs("tous")
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MENUS                                                                */
/* ------------------------------------------------------------------ */
function MenusTab({ menus, setMenus, recettes, setRecettes, accent, menuIdees, setMenuIdees, enfants }) {
  const [start, setStart] = useState(todayISO());
  const [duree, setDuree] = useState(7);
  const [filtreType, setFiltreType] = useState("Tous");
  const [view, setView] = useState("planning");

  const jours = useMemo(() => {
    const arr = [];
    const startEffectif = start < todayISO() ? todayISO() : start; // ne montre jamais un jour déjà passé
    const d0 = new Date(startEffectif + "T00:00:00");
    for (let i = 0; i < duree; i++) {
      const d = new Date(d0); d.setDate(d0.getDate() + i);
      arr.push(d.toISOString().slice(0, 10));
    }
    return arr;
  }, [start, duree]);

  const getEntry = (date, moment, type, pub = "tous") =>
    menus.find((m) => m.date === date && m.moment === moment && m.type === type && (m.public || "tous") === pub);
  const setEntry = (date, moment, type, nom, pub = "tous") => {
    const existing = getEntry(date, moment, type, pub);
    if (!nom.trim()) {
      if (existing) setMenus((prev) => prev.filter((m) => m.id !== existing.id));
      return;
    }
    if (existing) setMenus((prev) => prev.map((m) => (m.id === existing.id ? { ...m, nom } : m)));
    else setMenus((prev) => [...prev, { id: uid(), date, moment, type, nom, public: pub }]);

    // Un plat tapé directement dans le menu vient enrichir la liste des
    // recettes/idées, pour pouvoir le repiocher facilement plus tard.
    const nomPropre = nom.trim();
    setRecettes((prev) => {
      const dejaLa = prev.some((r) => r.type === type && r.nom.trim().toLowerCase() === nomPropre.toLowerCase());
      return dejaLa ? prev : [{ id: uid(), nom: nomPropre, type, lien: "", texte: "", ingredients: "", date: todayISO() }, ...prev];
    });
  };

  const historique = menus
    .filter((m) => filtreType === "Tous" || m.type === filtreType)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const compteUsage = useMemo(() => {
    const map = {};
    menus.forEach((m) => { map[m.nom] = (map[m.nom] || 0) + 1; });
    return map;
  }, [menus]);

  // --- Liste de courses générée depuis les menus prévus sur la période affichée ---
  const [coches, setCoches] = useState({});
  const [extraCourse, setExtraCourse] = useState("");
  const [extrasCourses, setExtrasCourses] = useState([]);

  const listeCourses = useMemo(() => {
    const map = {};
    jours.forEach((date) => {
      menus.filter((m) => m.date === date).forEach((m) => {
        const recette = recettes.find((r) => r.nom.trim().toLowerCase() === m.nom.trim().toLowerCase() && r.type === m.type);
        if (recette && recette.ingredients) {
          recette.ingredients.split("\n").map((s) => s.trim()).filter(Boolean).forEach((ing) => {
            const key = ing.toLowerCase();
            if (!map[key]) map[key] = { label: ing, count: 0 };
            map[key].count += 1;
          });
        }
      });
    });
    return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
  }, [jours, menus, recettes]);

  const ajouterExtraCourse = () => {
    if (!extraCourse.trim()) return;
    setExtrasCourses((prev) => [...prev, extraCourse.trim()]);
    setExtraCourse("");
  };

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex flex-wrap gap-2">
        {["planning", "historique", "courses"].map((v) => (
          <button key={v} onClick={() => setView(v)}
            className="px-3.5 py-1.5 rounded-full text-sm font-semibold capitalize"
            style={{ background: view === v ? accent.main : accent.soft, color: view === v ? "#fff" : accent.deep }}>
            {v}
          </button>
        ))}
      </div>

      {view === "planning" ? (
        <>
          <Card className="flex flex-wrap gap-3 items-end">
            <Field label="Date de début">
              <input type="date" className={inputCls} style={{ borderColor: LINE }} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Durée">
              <select className={inputCls} style={{ borderColor: LINE }} value={duree} onChange={(e) => setDuree(Number(e.target.value))}>
                <option value={7}>1 semaine</option>
                <option value={14}>2 semaines</option>
                <option value={21}>3 semaines</option>
                <option value={30}>1 mois</option>
              </select>
            </Field>
          </Card>

          <div className="flex flex-col gap-4">
            {jours.map((date) => (
              <Card key={date} className="p-4 sm:p-5">
                <p className="font-serif font-semibold capitalize mb-3.5 text-base" style={{ color: accent.deep }}>{formatDateFR(date)}</p>
                <div className="flex flex-col gap-3">
                  <MomentRow label="Midi" date={date} moment="midi" types={["Entrée", "Plat", "Dessert"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} />
                  <MomentRow label="Goûter" date={date} moment="gouter" types={["Goûter"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} single />
                  <MomentRow label="Soir" date={date} moment="soir" types={["Entrée", "Plat", "Dessert"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} />
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : view === "historique" ? (
        <Card>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <SectionTitle accent={accent}>Menus déjà utilisés</SectionTitle>
            <div className="flex gap-1.5 flex-wrap">
              {["Tous", ...TYPES_PLAT].map((t) => (
                <button key={t} onClick={() => setFiltreType(t)}
                  className="text-xs px-2.5 py-1 rounded-full font-semibold"
                  style={{ background: filtreType === t ? accent.main : accent.soft, color: filtreType === t ? "#fff" : accent.deep }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 max-h-[28rem] overflow-auto pr-1">
            {historique.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm py-1.5 border-b" style={{ borderColor: LINE }}>
                <div>
                  <p className="font-medium">{m.nom}</p>
                  <p className="text-xs capitalize" style={{ color: INK_SOFT }}>
                    {MOMENT_LABELS[m.moment] || ""} · {m.type} · {formatDateFR(m.date)}
                    {m.public && m.public !== "tous" && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: accent.soft, color: accent.deep }}>{m.public}</span>
                    )}
                  </p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: accent.soft, color: accent.deep }}>
                  utilisé {compteUsage[m.nom] || 1}×
                </span>
              </div>
            ))}
            {!historique.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun menu enregistré pour l'instant.</p>}
          </div>
        </Card>
      ) : (
        <Card>
          <SectionTitle accent={accent}>Liste de courses (générée du {formatDateFR(jours[0])} au {formatDateFR(jours[jours.length - 1])})</SectionTitle>
          <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
            Calculée à partir des ingrédients des recettes assignées à tes menus sur cette période (change la période dans l'onglet "planning"). Pense à renseigner les ingrédients de tes recettes pour que ça remonte ici.
          </p>
          <div className="flex flex-col gap-1 mb-3">
            {listeCourses.map((item) => (
              <label key={item.label} className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer" style={{ background: coches[item.label] ? accent.soft : "transparent" }}>
                <input type="checkbox" checked={!!coches[item.label]} onChange={() => setCoches((prev) => ({ ...prev, [item.label]: !prev[item.label] }))} className="w-4 h-4" />
                <span style={{ textDecoration: coches[item.label] ? "line-through" : "none", color: coches[item.label] ? accent.deep : INK }}>{item.label}</span>
                {item.count > 1 && <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ background: accent.soft, color: accent.deep }}>×{item.count}</span>}
              </label>
            ))}
            {extrasCourses.map((label, i) => (
              <label key={`extra-${i}`} className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer justify-between" style={{ background: coches[`extra-${i}`] ? accent.soft : "transparent" }}>
                <span className="flex items-center gap-2">
                  <input type="checkbox" checked={!!coches[`extra-${i}`]} onChange={() => setCoches((prev) => ({ ...prev, [`extra-${i}`]: !prev[`extra-${i}`] }))} className="w-4 h-4" />
                  <span style={{ textDecoration: coches[`extra-${i}`] ? "line-through" : "none" }}>{label}</span>
                </span>
                <button onClick={() => setExtrasCourses((prev) => prev.filter((_, idx) => idx !== i))} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
              </label>
            ))}
            {!listeCourses.length && !extrasCourses.length && (
              <p className="text-sm" style={{ color: INK_SOFT }}>Rien pour l'instant — ajoute des ingrédients à tes recettes assignées à cette période, ou ajoute un article manuellement ci-dessous.</p>
            )}
          </div>
          <div className="flex gap-2 pt-2 border-t" style={{ borderColor: LINE }}>
            <input className={inputCls + " flex-1"} style={{ borderColor: LINE }} value={extraCourse} onChange={(e) => setExtraCourse(e.target.value)} placeholder="Ajouter un article (ex. papier toilette)" onKeyDown={(e) => e.key === "Enter" && ajouterExtraCourse()} />
            <button onClick={ajouterExtraCourse} className="h-9 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
          </div>
        </Card>
      )}

      {!!menuIdees.length && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb size={16} style={{ color: accent.deep }} />
            <SectionTitle accent={accent}>Idées de repas proposées par les enfants</SectionTitle>
          </div>
          <div className="flex flex-col gap-1.5">
            {menuIdees.slice().reverse().map((idee) => {
              const enfant = enfants.find((e) => e.id === idee.enfantId);
              return (
                <div key={idee.id} className="flex items-center justify-between text-sm py-1.5 border-b" style={{ borderColor: LINE }}>
                  <div>
                    <p>{idee.texte}</p>
                    <p className="text-xs" style={{ color: INK_SOFT }}>proposé par {enfant ? enfant.prenom : "un enfant"} · {idee.date}</p>
                  </div>
                  <button onClick={() => setMenuIdees((prev) => prev.filter((i) => i.id !== idee.id))} className="opacity-40 hover:opacity-100 shrink-0"><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RECETTES                                                             */
/* ------------------------------------------------------------------ */
function RecettesTab({ recettes, setRecettes, menus, setMenus, accent }) {
  const [form, setForm] = useState({ nom: "", type: TYPES_PLAT[1], lien: "", texte: "", ingredients: "" });
  const [search, setSearch] = useState("");
  const [filtreType, setFiltreType] = useState("Tous");
  const [openId, setOpenId] = useState(null);
  const [assignId, setAssignId] = useState(null);
  const [assignForm, setAssignForm] = useState({ date: todayISO(), moment: "midi", pub: "tous" });

  const compteUsage = useMemo(() => {
    const map = {};
    menus.forEach((m) => { map[m.nom] = (map[m.nom] || 0) + 1; });
    return map;
  }, [menus]);

  const addRecette = () => {
    if (!form.nom.trim()) return;
    setRecettes([{ id: uid(), ...form, date: todayISO() }, ...recettes]);
    setForm({ nom: "", type: TYPES_PLAT[1], lien: "", texte: "", ingredients: "" });
  };
  const removeRecette = (id) => setRecettes((prev) => prev.filter((r) => r.id !== id));

  const assignerAuMenu = (recette) => {
    const { date, pub } = assignForm;
    const type = recette.type;
    const moment = type === "Goûter" ? "gouter" : assignForm.moment;
    setMenus((prev) => {
      const existant = prev.find((m) => m.date === date && m.moment === moment && m.type === type && (m.public || "tous") === pub);
      if (existant) return prev.map((m) => (m.id === existant.id ? { ...m, nom: recette.nom } : m));
      return [...prev, { id: uid(), date, moment, type, nom: recette.nom, public: pub }];
    });
    setAssignId(null);
  };

  const filtered = recettes.filter((r) =>
    (filtreType === "Tous" || r.type === filtreType) &&
    (r.nom.toLowerCase().includes(search.toLowerCase()) || r.texte.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <Card>
        <SectionTitle accent={accent}>Ajouter une recette</SectionTitle>
        <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
          Repéré sur TikTok, Instagram ou ailleurs ? Colle le lien de la vidéo et recopie le texte de la recette (légende, ingrédients, étapes) ci-dessous.
        </p>
        <div className="grid sm:grid-cols-2 gap-2.5 mb-2.5">
          <Field label="Nom du plat">
            <input className={inputCls} style={{ borderColor: LINE }} value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} placeholder="Ex. Tiramisu au spéculoos" />
          </Field>
          <Field label="Type">
            <select className={inputCls} style={{ borderColor: LINE }} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {TYPES_PLAT.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Lien (TikTok / Instagram / autre)">
          <input className={inputCls} style={{ borderColor: LINE }} value={form.lien} onChange={(e) => setForm({ ...form, lien: e.target.value })} placeholder="https://..." />
        </Field>
        <div className="h-2.5" />
        <Field label="Ingrédients (un par ligne — sert à générer la liste de courses)">
          <textarea className={inputCls + " min-h-[70px]"} style={{ borderColor: LINE }} value={form.ingredients} onChange={(e) => setForm({ ...form, ingredients: e.target.value })} placeholder={"Farine\n2 œufs\nSucre..."} />
        </Field>
        <div className="h-2.5" />
        <Field label="Recette (ingrédients, étapes...)">
          <textarea className={inputCls + " min-h-[90px]"} style={{ borderColor: LINE }} value={form.texte} onChange={(e) => setForm({ ...form, texte: e.target.value })} placeholder="Colle ici le texte de la recette" />
        </Field>
        <button onClick={addRecette} className="mt-3 h-9 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: accent.main }}><Plus size={15} />Enregistrer la recette</button>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionTitle accent={accent}>Mes recettes ({filtered.length})</SectionTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2 top-2" style={{ color: INK_SOFT }} />
              <input className={inputCls + " pl-7"} style={{ borderColor: LINE }} placeholder="Rechercher" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap mb-3">
          {["Tous", ...TYPES_PLAT].map((t) => (
            <button key={t} onClick={() => setFiltreType(t)}
              className="text-xs px-2.5 py-1 rounded-full font-semibold"
              style={{ background: filtreType === t ? accent.main : accent.soft, color: filtreType === t ? "#fff" : accent.deep }}>
              {t}
            </button>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {filtered.map((r) => (
            <div key={r.id} className="rounded-lg border p-3" style={{ borderColor: LINE }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-serif font-semibold">{r.nom}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: accent.soft, color: accent.deep }}>{r.type}</span>
                    {!!compteUsage[r.nom] && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#E4EBDF", color: "#425840" }}>
                        faite {compteUsage[r.nom]}×
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => removeRecette(r.id)} className="opacity-40 hover:opacity-100 shrink-0"><Trash2 size={14} /></button>
              </div>
              {r.lien && (
                <a href={r.lien} target="_blank" rel="noreferrer" className="text-xs flex items-center gap-1 mt-1.5 hover:underline" style={{ color: accent.main }}>
                  <LinkIcon size={12} /> Voir la vidéo d'origine
                </a>
              )}
              <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-xs mt-1.5 font-semibold" style={{ color: accent.deep }}>
                {openId === r.id ? "Masquer" : "Voir / ajouter les ingrédients"}
              </button>
              {openId === r.id && (
                <div className="mt-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: INK_SOFT }}>Ingrédients</p>
                  <textarea
                    defaultValue={r.ingredients || ""}
                    onBlur={(e) => setRecettes((prev) => prev.map((x) => (x.id === r.id ? { ...x, ingredients: e.target.value } : x)))}
                    placeholder={"Un ingrédient par ligne (pour la liste de courses)"}
                    className={inputCls + " w-full min-h-[60px] mb-2"} style={{ borderColor: LINE }}
                  />
                  {r.texte && <p className="text-sm whitespace-pre-wrap" style={{ color: INK }}>{r.texte}</p>}
                </div>
              )}

              <button
                onClick={() => setAssignId(assignId === r.id ? null : r.id)}
                className="text-xs mt-2 font-semibold flex items-center gap-1"
                style={{ color: accent.deep }}
              >
                <CalendarDays size={12} />{assignId === r.id ? "Annuler" : "Ajouter à un menu"}
              </button>

              {assignId === r.id && (
                <div className="mt-2 pt-2 border-t flex flex-wrap gap-2 items-end" style={{ borderColor: LINE }}>
                  <Field label="Date">
                    <input type="date" className={inputCls} style={{ borderColor: LINE }} value={assignForm.date} onChange={(e) => setAssignForm({ ...assignForm, date: e.target.value })} />
                  </Field>
                  {r.type !== "Goûter" && (
                    <Field label="Moment">
                      <select className={inputCls} style={{ borderColor: LINE }} value={assignForm.moment} onChange={(e) => setAssignForm({ ...assignForm, moment: e.target.value })}>
                        <option value="midi">Midi</option>
                        <option value="soir">Soir</option>
                      </select>
                    </Field>
                  )}
                  <Field label="Pour">
                    <select className={inputCls} style={{ borderColor: LINE }} value={assignForm.pub} onChange={(e) => setAssignForm({ ...assignForm, pub: e.target.value })}>
                      <option value="tous">Tout le monde</option>
                      <option value="parents">Parents</option>
                      <option value="enfants">Enfants</option>
                    </select>
                  </Field>
                  <button
                    onClick={() => assignerAuMenu(r)}
                    className="h-8 px-3 rounded-md text-sm font-semibold text-white"
                    style={{ background: accent.main }}
                  >
                    Ajouter
                  </button>
                </div>
              )}
            </div>
          ))}
          {!filtered.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune recette pour l'instant.</p>}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ÉPARGNE — objectifs thématiques                                     */
/* ------------------------------------------------------------------ */
function EpargneTab({ epargnes, setEpargnes, accent }) {
  const [form, setForm] = useState({ theme: "", objectif: "" });
  const [montants, setMontants] = useState({});

  const addTheme = () => {
    if (!form.theme.trim() || !form.objectif) return;
    setEpargnes((prev) => [...prev, { id: uid(), theme: form.theme.trim(), objectif: Number(form.objectif), montant: 0 }]);
    setForm({ theme: "", objectif: "" });
  };
  const removeTheme = (id) => setEpargnes((prev) => prev.filter((e) => e.id !== id));
  const verser = (id, sens) => {
    const val = Number(montants[id] || 0);
    if (!val) return;
    setEpargnes((prev) => prev.map((e) => (e.id === id ? { ...e, montant: Math.max(0, e.montant + sens * val) } : e)));
    setMontants({ ...montants, [id]: "" });
  };
  const setMontantDirect = (id, montant) => setEpargnes((prev) => prev.map((e) => (e.id === id ? { ...e, montant: Math.max(0, Number(montant) || 0) } : e)));
  const setObjectifDirect = (id, objectif) => setEpargnes((prev) => prev.map((e) => (e.id === id ? { ...e, objectif: Number(objectif) || 0 } : e)));

  const totalEpargne = epargnes.reduce((s, e) => s + e.montant, 0);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="rounded-lg p-5" style={{ background: accent.soft }}>
        <p className="text-xs uppercase tracking-wide font-semibold" style={{ color: accent.deep }}>Total épargné, tous thèmes confondus</p>
        <p className="text-3xl font-serif font-bold" style={{ color: accent.deep }}>{formatEUR(totalEpargne)}</p>
      </div>

      <Card>
        <SectionTitle accent={accent}>Nouveau thème d'épargne</SectionTitle>
        <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
          C'est ici que tu prévois tes grosses dépenses futures : réparation voiture, vacances, un nouvel appareil... Crée un thème avec un objectif, puis verse dedans au fil du temps pour suivre où tu en es.
        </p>
        <div className="flex flex-wrap gap-2.5 items-end">
          <Field label="Thème">
            <input className={inputCls} style={{ borderColor: LINE }} value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })} placeholder="Réparation voiture, Vacances..." />
          </Field>
          <Field label="Objectif (€)">
            <input type="number" className={inputCls + " w-32"} style={{ borderColor: LINE }} value={form.objectif} onChange={(e) => setForm({ ...form, objectif: e.target.value })} />
          </Field>
          <button onClick={addTheme} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Créer</button>
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        {epargnes.map((e) => {
          const pct = Math.min(100, (e.montant / e.objectif) * 100);
          return (
            <Card key={e.id}>
              <div className="flex items-start justify-between mb-2">
                <p className="font-serif font-semibold text-lg">{e.theme}</p>
                <button onClick={() => removeTheme(e.id)} className="opacity-40 hover:opacity-100"><Trash2 size={14} /></button>
              </div>
              <div className="h-2.5 rounded-full bg-black/5 mb-1.5">
                <div className="h-2.5 rounded-full" style={{ width: `${pct}%`, background: accent.main }} />
              </div>
              <div className="flex items-center gap-1.5 text-sm mb-3" style={{ color: INK_SOFT }}>
                <input type="number" step="0.01" defaultValue={e.montant} onBlur={(ev) => setMontantDirect(e.id, ev.target.value)}
                  className="w-20 border rounded px-1.5 py-0.5 bg-white text-right" style={{ borderColor: LINE }} />
                <span>/</span>
                <input type="number" step="0.01" defaultValue={e.objectif} onBlur={(ev) => setObjectifDirect(e.id, ev.target.value)}
                  className="w-20 border rounded px-1.5 py-0.5 bg-white text-right" style={{ borderColor: LINE }} />
                <span>€ ({Math.round(pct)}%)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input type="number" placeholder="Montant" className={inputCls + " w-24"} style={{ borderColor: LINE }}
                  value={montants[e.id] || ""} onChange={(ev) => setMontants({ ...montants, [e.id]: ev.target.value })} />
                <button onClick={() => verser(e.id, 1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold text-white" style={{ background: accent.main }}>Verser</button>
                <button onClick={() => verser(e.id, -1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>Retirer</button>
              </div>
            </Card>
          );
        })}
        {!epargnes.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun objectif pour l'instant — crée ton premier thème d'épargne.</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ENFANTS — vue enfant : argent de poche, jauge, bons points, tâches   */
/* ------------------------------------------------------------------ */
const TACHES_DE_BASE = [
  { titre: "Ranger sa chambre", emoji: "🧸" },
  { titre: "Débarrasser la table", emoji: "🍽️" },
  { titre: "Mettre la table", emoji: "🍴" },
  { titre: "Faire son lit", emoji: "🛏️" },
  { titre: "Sortir les poubelles", emoji: "🗑️" },
  { titre: "Vider le lave-vaisselle", emoji: "🧽" },
  { titre: "Passer l'aspirateur", emoji: "🧹" },
  { titre: "Nourrir l'animal", emoji: "🐾" },
];
const TACHE_EMOJI_PAR_TITRE = Object.fromEntries(TACHES_DE_BASE.map((t) => [t.titre, t.emoji]));
function emojiTache(titre) {
  return TACHE_EMOJI_PAR_TITRE[titre] || "⭐";
}

const SANCTIONS_DE_BASE = [
  { motif: "Dispute / bagarre", emoji: "🥊", points: 10 },
  { motif: "Chambre en bazar", emoji: "🧦", points: 5 },
  { motif: "Salit la maison", emoji: "🫧", points: 5 },
  { motif: "Répond (insolence)", emoji: "😤", points: 10 },
  { motif: "Trop de temps sur le téléphone", emoji: "📱", points: 5 },
];

function EnfantsTab({ enfants, setEnfants, taches, setTaches, recompenses, setRecompenses, menus, menuIdees, setMenuIdees, parentPin, setParentPin, sanctions, setSanctions, sanctionsPerso, setSanctionsPerso, lecturesSessions, setLecturesSessions, familyCode, enfantActifId, onChangerProfil, accent }) {
  const [selectedId, setSelectedId] = useState(enfants[0]?.id || null);
  const [newPrenom, setNewPrenom] = useState("");
  const [tacheForm, setTacheForm] = useState({ titre: "", points: 5, rappelDate: "" });
  const [recForm, setRecForm] = useState({ titre: "", coutPoints: 20 });
  const [idee, setIdee] = useState("");
  const [ajustePoche, setAjustePoche] = useState("");
  const [ajustePoints, setAjustePoints] = useState("");
  const [sanctionForm, setSanctionForm] = useState({ motif: "", points: 5 });
  const [nouveauMotif, setNouveauMotif] = useState({ motif: "", points: 5 });
  const [jaugeForm, setJaugeForm] = useState({ label: "", cible: 50, recompense: 5 });

  // Verrou parent : déverrouillage valable pour la session en cours
  // (perdu si on quitte l'onglet ou recharge la page — les enfants ne
  // peuvent pas laisser le mode ouvert en permanence).
  const [modeParent, setModeParent] = useState(false);
  const [pinSaisi, setPinSaisi] = useState("");
  const [erreurPin, setErreurPin] = useState("");

  useEffect(() => {
    if (!selectedId && enfants.length) setSelectedId(enfants[0].id);
  }, [enfants]);

  // Espace enfant verrouillé : on force la sélection sur le profil choisi
  // à l'écran "Qui es-tu ?", impossible de voir les autres.
  useEffect(() => {
    if (enfantActifId) setSelectedId(enfantActifId);
  }, [enfantActifId]);

  // Change d'enfant sélectionné → on vide les brouillons de formulaire
  // (jauge, ajustements...) pour ne jamais laisser croire qu'une valeur
  // saisie pour un enfant "colle" à un autre.
  useEffect(() => {
    setJaugeForm({ label: "", cible: 50, recompense: 5 });
    setAjustePoche("");
    setAjustePoints("");
    setTacheForm({ titre: "", points: 5, rappelDate: "" });
    setRecForm({ titre: "", coutPoints: 20 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const enfant = enfants.find((e) => e.id === selectedId);
  const today = todayISO();

  const tenterDeverrouiller = () => {
    if (!parentPin) {
      if (pinSaisi.trim().length < 4) { setErreurPin("Choisis un code d'au moins 4 chiffres."); return; }
      setParentPin(pinSaisi.trim());
      setModeParent(true);
      setPinSaisi(""); setErreurPin("");
      return;
    }
    if (pinSaisi === parentPin) { setModeParent(true); setPinSaisi(""); setErreurPin(""); }
    else setErreurPin("Code incorrect.");
  };

  const [bioActivee, setBioActivee] = useState(() => !!localStorage.getItem(cleBiometrie(familyCode)));
  const [erreurBio, setErreurBio] = useState("");
  const activerBio = async () => {
    setErreurBio("");
    try {
      await enregistrerBiometrie(familyCode);
      setBioActivee(true);
    } catch (e) {
      setErreurBio("Impossible d'activer — ton appareil ne supporte peut-être pas Face ID/empreinte, ou tu as annulé.");
    }
  };
  const deverrouillerBio = async () => {
    setErreurBio("");
    try {
      const ok = await deverrouillerAvecBiometrie(familyCode);
      if (ok) setModeParent(true);
    } catch (e) {
      setErreurBio("Échec de la vérification (annulé ou non reconnu).");
    }
  };

  // --- Défi lecture : chrono démarrable par l'enfant ou par un parent ---
  const [chronoDebut, setChronoDebut] = useState(null); // timestamp (ms) ou null si arrêté
  const [chronoEcoule, setChronoEcoule] = useState(0); // secondes, mis à jour en direct
  useEffect(() => {
    if (chronoDebut === null) return;
    const interval = setInterval(() => setChronoEcoule(Math.floor((Date.now() - chronoDebut) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [chronoDebut]);
  const demarrerChrono = () => { setChronoDebut(Date.now()); setChronoEcoule(0); };
  const arreterChrono = () => {
    const secondes = Math.floor((Date.now() - chronoDebut) / 1000);
    setChronoDebut(null);
    setChronoEcoule(0);
    if (secondes < 10 || !selectedId) return; // ignore les arrêts trop rapides (clic accidentel)
    const points = Math.round((secondes / 60) * 0.5 * 10) / 10; // 0,5 point par minute lue
    setLecturesSessions((prev) => [{ id: uid(), enfantId: selectedId, date: todayISO(), dureeSec: secondes, points, valide: false }, ...prev]);
  };
  const validerLecture = (l) => {
    setLecturesSessions((prev) => prev.map((x) => (x.id === l.id ? { ...x, valide: true } : x)));
    setEnfants((prev) => prev.map((e) => (e.id === l.enfantId ? { ...e, bonPoints: e.bonPoints + l.points } : e)));
  };
  const refuserLecture = (l) => setLecturesSessions((prev) => prev.filter((x) => x.id !== l.id));
  const formatDureeChrono = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };
  const lecturesEnfant = lecturesSessions.filter((l) => l.enfantId === selectedId).sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalMinutesLues = Math.round(lecturesEnfant.filter((l) => l.valide).reduce((s, l) => s + l.dureeSec, 0) / 60);

  const addEnfant = () => {
    if (!newPrenom.trim()) return;
    const e = { id: uid(), prenom: newPrenom.trim(), soldePoche: 0, bonPoints: 0, jaugeLabel: "", jaugeCible: 0, jaugeRecompense: 0 };
    setEnfants((prev) => [...prev, e]);
    // Les tâches de base sont créées automatiquement pour tout nouvel enfant
    setTaches((prev) => [...prev, ...TACHES_DE_BASE.map((t) => ({ id: uid(), enfantId: e.id, titre: t.titre, points: 5, rappelDate: "", statut: "a_faire" }))]);
    setSelectedId(e.id);
    setNewPrenom("");
  };
  const removeEnfant = (id) => {
    setEnfants((prev) => prev.filter((e) => e.id !== id));
    setTaches((prev) => prev.filter((t) => t.enfantId !== id));
    setRecompenses((prev) => prev.filter((r) => r.enfantId !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // Rattrape les enfants existants qui n'ont pas encore une tâche de base donnée
  // (utile si on l'a ajoutée après coup, ou pour des enfants créés avant ce système).
  const [messageRattrapage, setMessageRattrapage] = useState("");
  const rattraperTachesDeBase = () => {
    let compteur = 0;
    setTaches((prev) => {
      // Un modèle par titre déjà existant quelque part (base + tâches perso
      // déjà créées avant ou après ce système) — on prend les points de la
      // première occurrence trouvée pour ce titre.
      const modeles = {};
      TACHES_DE_BASE.forEach((t) => { modeles[t.titre] = 5; });
      prev.forEach((t) => { if (!(t.titre in modeles)) modeles[t.titre] = t.points; });

      const nouvelles = [];
      enfants.forEach((enf) => {
        Object.entries(modeles).forEach(([titre, points]) => {
          const dejaLa = prev.some((x) => x.enfantId === enf.id && x.titre === titre) || nouvelles.some((x) => x.enfantId === enf.id && x.titre === titre);
          if (!dejaLa) nouvelles.push({ id: uid(), enfantId: enf.id, titre, points, rappelDate: "", statut: "a_faire" });
        });
      });
      compteur = nouvelles.length;
      return nouvelles.length ? [...prev, ...nouvelles] : prev;
    });
    setTimeout(() => {
      setMessageRattrapage(compteur > 0 ? `${compteur} tâche${compteur > 1 ? "s" : ""} ajoutée${compteur > 1 ? "s" : ""} !` : "Tout était déjà à jour, rien à ajouter.");
      setTimeout(() => setMessageRattrapage(""), 4000);
    }, 0);
  };

  // Accepte soit un objet (patch direct), soit une fonction (e) => patch,
  // qui reçoit l'enfant le plus À JOUR (celui de "prev", pas une valeur
  // potentiellement périmée capturée plus tôt dans le rendu) — ça évite
  // qu'un clic rapide se base sur un ancien total et fausse le calcul.
  const updateEnfant = (patch) => setEnfants((prev) => prev.map((e) => (e.id === selectedId ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) } : e)));

  const ajusterSolde = (sens) => {
    const val = Number(ajustePoche || 0);
    if (!val || !enfant) return;
    updateEnfant((e) => ({ soldePoche: Math.max(0, e.soldePoche + sens * val) }));
    setAjustePoche("");
  };

  const ajusterPoints = (sens) => {
    const val = Number(ajustePoints || 0);
    if (!val || !enfant) return;
    updateEnfant((e) => ({ bonPoints: e.bonPoints + sens * val }));
    setAjustePoints("");
  };

  const sanctionsEnfant = sanctions.filter((s) => s.enfantId === selectedId).sort((a, b) => (a.date < b.date ? 1 : -1));
  const appliquerSanction = (motif, points) => {
    if (!enfant || !motif.trim() || !points) return;
    setSanctions((prev) => [{ id: uid(), enfantId: selectedId, motif: motif.trim(), points: Number(points), date: todayISO() }, ...prev]);
    updateEnfant((e) => ({ bonPoints: e.bonPoints - Number(points) }));
  };
  const annulerSanction = (s) => {
    setSanctions((prev) => prev.filter((x) => x.id !== s.id));
    updateEnfant((e) => ({ bonPoints: e.bonPoints + s.points }));
  };
  // Motifs de sanction réutilisables ajoutés par la famille, en plus des motifs de base
  const motifsSanction = [...SANCTIONS_DE_BASE, ...sanctionsPerso.map((s) => ({ motif: s.motif, emoji: s.emoji || "⚠️", points: s.points, perso: true, id: s.id }))];
  const ajouterMotifSanctionPerso = () => {
    if (!nouveauMotif.motif.trim() || !nouveauMotif.points) return;
    setSanctionsPerso((prev) => [...prev, { id: uid(), motif: nouveauMotif.motif.trim(), points: Number(nouveauMotif.points), emoji: "⚠️" }]);
    setNouveauMotif({ motif: "", points: 5 });
  };
  const supprimerMotifSanctionPerso = (id) => setSanctionsPerso((prev) => prev.filter((s) => s.id !== id));

  const tachesEnfant = taches.filter((t) => t.enfantId === selectedId);
  const addTache = (titre, points) => {
    const titreFinal = (titre || tacheForm.titre).trim();
    if (!titreFinal || !enfants.length) return;
    const pts = Number(points ?? tacheForm.points) || 0;
    const rappel = titre ? "" : tacheForm.rappelDate;
    setTaches((prev) => {
      const nouvelles = enfants
        .filter((enf) => !prev.some((t) => t.enfantId === enf.id && t.titre === titreFinal))
        .map((enf) => ({ id: uid(), enfantId: enf.id, titre: titreFinal, points: pts, rappelDate: rappel, statut: "a_faire" }));
      return nouvelles.length ? [...prev, ...nouvelles] : prev;
    });
    if (!titre) setTacheForm({ titre: "", points: 5, rappelDate: "" });
  };
  const removeTache = (id) => setTaches((prev) => prev.filter((t) => t.id !== id));
  // Action enfant : signaler que la tâche est faite → passe "en attente de validation".
  // Ne donne aucun point tant qu'un parent n'a pas validé.
  const marquerFait = (t) => {
    setTaches((prev) => prev.map((x) => (x.id === t.id ? { ...x, statut: x.statut === "a_faire" ? "en_attente" : "a_faire" } : x)));
  };
  // Actions parent uniquement : valider donne les points, refuser renvoie la tâche à faire.
  const validerTache = (t) => {
    const today = todayISO();
    setTaches((prev) => prev.map((x) => (x.id === t.id ? {
      ...x,
      statut: "a_faire", // repasse dispo tout de suite : peut être refaite plusieurs fois dans la journée
      derniereDate: today,
      foisAujourdhui: x.derniereDate === today ? (x.foisAujourdhui || 0) + 1 : 1,
    } : x)));
    updateEnfant((e) => ({ bonPoints: e.bonPoints + t.points }));
  };
  const refuserTache = (t) => {
    setTaches((prev) => prev.map((x) => (x.id === t.id ? { ...x, statut: "a_faire" } : x)));
  };

  const recompensesEnfant = recompenses.filter((r) => r.enfantId === selectedId);
  const addRecompense = () => {
    if (!recForm.titre.trim() || !enfant) return;
    setRecompenses((prev) => [...prev, { id: uid(), enfantId: selectedId, titre: recForm.titre.trim(), coutPoints: Number(recForm.coutPoints) || 0 }]);
    setRecForm({ titre: "", coutPoints: 20 });
  };
  const removeRecompense = (id) => setRecompenses((prev) => prev.filter((r) => r.id !== id));
  const echangerRecompense = (r) => {
    if (!enfant || enfant.bonPoints < r.coutPoints) return;
    updateEnfant((e) => ({ bonPoints: e.bonPoints - r.coutPoints }));
  };

  const activerJauge = () => {
    if (!enfant || !Number(jaugeForm.cible) || !Number(jaugeForm.recompense)) return;
    const label = jaugeForm.label.trim() || `Gagner ${formatEUR(Number(jaugeForm.recompense))}`;
    updateEnfant({ jaugeLabel: label, jaugeCible: Number(jaugeForm.cible) || 0, jaugeRecompense: Number(jaugeForm.recompense) || 0 });
    setJaugeForm({ label: "", cible: 50, recompense: 5 });
  };
  const encaisserJauge = () => {
    if (!enfant || enfant.bonPoints < enfant.jaugeCible) return;
    updateEnfant((e) => ({ soldePoche: e.soldePoche + e.jaugeRecompense, bonPoints: e.bonPoints - e.jaugeCible }));
  };

  const prochainMenus = menus.filter((m) => m.date >= today).sort((a, b) => (a.date > b.date ? 1 : -1)).slice(0, 12);

  const envoyerIdee = () => {
    if (!idee.trim() || !enfant) return;
    setMenuIdees((prev) => [...prev, { id: uid(), enfantId: selectedId, texte: idee.trim(), date: today }]);
    setIdee("");
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      {/* Verrou parent */}
      <div className="rounded-lg p-3 flex flex-wrap items-center justify-between gap-2" style={{ background: modeParent ? accent.soft : "#F3D6D6" }}>
        <span className="text-sm font-semibold flex items-center gap-2" style={{ color: modeParent ? accent.deep : "#A33B3B" }}>
          {modeParent ? <Unlock size={16} /> : <Lock size={16} />}
          {modeParent ? "Mode parent déverrouillé" : "Mode enfant — seuls les parents peuvent modifier"}
        </span>
        {modeParent ? (
          <div className="flex items-center gap-2 flex-wrap">
            {biometrieDisponible() && !bioActivee && (
              <button onClick={activerBio} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border flex items-center gap-1" style={{ borderColor: LINE, color: accent.deep }}>
                📱 Activer Face ID / empreinte sur cet appareil
              </button>
            )}
            {bioActivee && <span className="text-xs" style={{ color: INK_SOFT }}>📱 Face ID/empreinte activée sur cet appareil</span>}
            <button onClick={() => setModeParent(false)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>Reverrouiller</button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            {biometrieDisponible() && bioActivee && (
              <button onClick={deverrouillerBio} className="text-xs px-2.5 py-1.5 rounded-md font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}>
                📱 Déverrouiller avec Face ID / empreinte
              </button>
            )}
            <input
              type="password"
              inputMode="numeric"
              className={inputCls + " w-28"}
              style={{ borderColor: LINE }}
              placeholder={parentPin ? "Code parent" : "Créer un code"}
              value={pinSaisi}
              onChange={(e) => setPinSaisi(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tenterDeverrouiller()}
            />
            <button onClick={tenterDeverrouiller} className="text-xs px-2.5 py-1.5 rounded-md font-semibold text-white" style={{ background: accent.main }}>
              {parentPin ? "Déverrouiller" : "Créer le code"}
            </button>
          </div>
        )}
      </div>
      {erreurPin && <p className="text-xs -mt-4" style={{ color: "#A33B3B" }}>{erreurPin}</p>}
      {erreurBio && <p className="text-xs -mt-4" style={{ color: "#A33B3B" }}>{erreurBio}</p>}

      <Card>
        {enfantActifId ? (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="px-3 py-1.5 rounded-full text-sm font-semibold" style={{ background: accent.main, color: "#fff" }}>{enfant?.prenom}</span>
            {onChangerProfil && (
              <button onClick={onChangerProfil} className="text-xs underline" style={{ color: INK_SOFT }}>Ce n'est pas moi</button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {enfants.map((e) => (
              <button key={e.id} onClick={() => setSelectedId(e.id)}
                className="px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
                style={{ background: selectedId === e.id ? accent.main : accent.soft, color: selectedId === e.id ? "#fff" : accent.deep }}>
                {e.prenom}
              </button>
            ))}
            {modeParent && (
              <>
                <input className={inputCls + " w-32"} style={{ borderColor: LINE }} placeholder="Prénom" value={newPrenom} onChange={(e) => setNewPrenom(e.target.value)} />
                <button onClick={addEnfant} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter un enfant</button>
              </>
            )}
          </div>
        )}
      </Card>

      {!enfantActifId && enfants.length >= 2 && (
        <Card>
          <SectionTitle accent={accent}>🏆 Classement des bons points</SectionTitle>
          <div className="flex flex-col gap-2">
            {[...enfants].sort((a, b) => b.bonPoints - a.bonPoints).map((e, i, arr) => {
              const titres = [
                "👑 Le Boss du mois",
                "🥈 Le Vice-Boss",
                "🥉 La Terreur du classement",
              ];
              const estDernier = i === arr.length - 1 && arr.length > 3;
              const titre = estDernier ? "🌱 Prêt·e à tout exploser le mois prochain" : (titres[i] || "⭐ Toujours dans la course");
              return (
                <div key={e.id} className="flex items-center justify-between px-3 py-2 rounded-md" style={{ background: i === 0 ? accent.soft : "transparent", border: `1px solid ${LINE}` }}>
                  <div className="flex items-center gap-3">
                    <span className="font-serif font-bold text-lg w-6 text-center" style={{ color: accent.deep }}>{i + 1}</span>
                    <div>
                      <p className="font-semibold">{e.prenom}</p>
                      <p className="text-xs" style={{ color: INK_SOFT }}>{titre}</p>
                    </div>
                  </div>
                  <span className="font-serif font-bold flex items-center gap-1" style={{ color: e.bonPoints < 0 ? "#A33B3B" : accent.deep }}><Star size={15} />{e.bonPoints}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {!enfant ? (
        <p className="text-sm" style={{ color: INK_SOFT }}>{modeParent ? "Ajoute un enfant pour créer son profil." : "Aucun profil pour l'instant."}</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-serif font-semibold">{enfant.prenom}</h3>
            {modeParent && (
              <button onClick={() => removeEnfant(enfant.id)} className="text-xs px-2.5 py-1 rounded-md border font-semibold flex items-center gap-1" style={{ borderColor: LINE, color: INK_SOFT }}><Trash2 size={13} />Supprimer ce profil</button>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {/* Argent de poche */}
            <Card>
              <SectionTitle accent={accent}>Argent de poche</SectionTitle>
              <p className="text-2xl font-serif font-bold mb-2" style={{ color: accent.deep }}>{formatEUR(enfant.soldePoche)}</p>
              {modeParent && (
                <div className="flex items-center gap-1.5">
                  <input type="number" placeholder="Montant" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={ajustePoche} onChange={(e) => setAjustePoche(e.target.value)} />
                  <button onClick={() => ajusterSolde(1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold text-white" style={{ background: accent.main }}>+ Ajouter</button>
                  <button onClick={() => ajusterSolde(-1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>− Retirer</button>
                </div>
              )}
            </Card>

            {/* Bons points */}
            <Card>
              <SectionTitle accent={accent}>Bons points</SectionTitle>
              <p className="text-2xl font-serif font-bold flex items-center gap-2 mb-2" style={{ color: enfant.bonPoints < 0 ? "#A33B3B" : accent.deep }}><Star size={22} />{enfant.bonPoints}</p>
              {modeParent ? (
                <div className="flex items-center gap-1.5">
                  <input type="number" placeholder="Points" className={inputCls + " w-20"} style={{ borderColor: LINE }} value={ajustePoints} onChange={(e) => setAjustePoints(e.target.value)} />
                  <button onClick={() => ajusterPoints(1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={13} />Donner</button>
                  <button onClick={() => ajusterPoints(-1)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border flex items-center gap-1" style={{ borderColor: LINE, color: INK_SOFT }}><Minus size={13} />Retirer</button>
                </div>
              ) : (
                <p className="text-xs" style={{ color: INK_SOFT }}>Gagnés en cochant les tâches ménagères ci-dessous.</p>
              )}
            </Card>
          </div>

          {/* Comportement — pertes de points (parent uniquement) */}
          {modeParent && (
            <Card>
              <SectionTitle accent={accent}>Comportement — retirer des points</SectionTitle>
              <p className="text-xs mb-2" style={{ color: INK_SOFT }}>Clique sur un motif pour retirer directement les points correspondants.</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {motifsSanction.map((s) => (
                  <span key={s.perso ? s.id : s.motif} className="inline-flex items-center">
                    <button onClick={() => appliquerSanction(s.motif, s.points)}
                      className="text-xs px-2.5 py-1 rounded-full font-semibold border flex items-center gap-1"
                      style={{ borderColor: "#E3B3AC", color: "#A33B3B", background: "#FBEAE8", borderTopRightRadius: s.perso ? 0 : undefined, borderBottomRightRadius: s.perso ? 0 : undefined }}>
                      <span>{s.emoji}</span> {s.motif} (−{s.points})
                    </button>
                    {s.perso && (
                      <button onClick={() => supprimerMotifSanctionPerso(s.id)} className="text-xs px-1.5 py-1 rounded-full border-y border-r font-semibold" style={{ borderColor: "#E3B3AC", color: "#A33B3B", background: "#FBEAE8" }} title="Supprimer ce motif de la liste">
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 items-end pt-2 border-t mb-3" style={{ borderColor: LINE }}>
                <Field label="Ajouter un motif à la liste">
                  <input className={inputCls} style={{ borderColor: LINE }} value={nouveauMotif.motif} onChange={(e) => setNouveauMotif({ ...nouveauMotif, motif: e.target.value })} placeholder="Ex. Ment délibérément" />
                </Field>
                <Field label="Points">
                  <input type="number" className={inputCls + " w-20"} style={{ borderColor: LINE }} value={nouveauMotif.points} onChange={(e) => setNouveauMotif({ ...nouveauMotif, points: e.target.value })} />
                </Field>
                <button onClick={ajouterMotifSanctionPerso} className="h-8 px-3 rounded-md text-sm font-semibold border flex items-center gap-1" style={{ borderColor: LINE, color: "#A33B3B" }}><Plus size={15} />Ajouter à la liste</button>
              </div>
              <div className="flex flex-wrap gap-2 items-end pt-2 border-t mb-3" style={{ borderColor: LINE }}>
                <Field label="Motif ponctuel (pas sauvegardé dans la liste)">
                  <input className={inputCls} style={{ borderColor: LINE }} value={sanctionForm.motif} onChange={(e) => setSanctionForm({ ...sanctionForm, motif: e.target.value })} placeholder="Autre motif..." />
                </Field>
                <Field label="Points à retirer">
                  <input type="number" className={inputCls + " w-20"} style={{ borderColor: LINE }} value={sanctionForm.points} onChange={(e) => setSanctionForm({ ...sanctionForm, points: e.target.value })} />
                </Field>
                <button onClick={() => { appliquerSanction(sanctionForm.motif, sanctionForm.points); setSanctionForm({ motif: "", points: 5 }); }} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: "#A33B3B" }}><Minus size={15} />Retirer</button>
              </div>
              {!!sanctionsEnfant.length && (
                <div className="flex flex-col gap-1 max-h-40 overflow-auto pt-2 border-t" style={{ borderColor: LINE }}>
                  {sanctionsEnfant.map((s) => (
                    <div key={s.id} className="flex items-center justify-between text-sm py-1">
                      <span>{s.motif} <span className="text-xs" style={{ color: INK_SOFT }}>· {formatDateFR(s.date)}</span></span>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold" style={{ color: "#A33B3B" }}>−{s.points}</span>
                        <button onClick={() => annulerSanction(s)} className="text-xs underline" style={{ color: INK_SOFT }}>annuler</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Défi lecture — chrono démarrable par l'enfant ou le parent */}
          <Card>
            <SectionTitle accent={accent}>📖 Défi lecture</SectionTitle>
            <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
              Lance le chrono avant de commencer à lire, arrête-le à la fin — ça donne 0,5 point par minute lue, une fois validé par un parent. Accessible sans code parent.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
              <p className="font-serif font-bold text-3xl tabular-nums" style={{ color: chronoDebut ? accent.deep : INK_SOFT }}>
                {formatDureeChrono(chronoEcoule)}
              </p>
              {chronoDebut === null ? (
                <button onClick={demarrerChrono} className="h-10 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: accent.main }}>
                  ▶ Démarrer la lecture
                </button>
              ) : (
                <button onClick={arreterChrono} className="h-10 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: "#A33B3B" }}>
                  ■ Arrêter
                </button>
              )}
              <span className="text-sm" style={{ color: INK_SOFT }}>Total lu (validé) : <strong style={{ color: accent.deep }}>{totalMinutesLues} min</strong></span>
            </div>
            {!!lecturesEnfant.length && (
              <div className="flex flex-col gap-1 mt-3 pt-3 border-t max-h-52 overflow-auto" style={{ borderColor: LINE }}>
                {lecturesEnfant.slice(0, 15).map((l) => (
                  <div key={l.id} className="flex items-center justify-between text-sm py-1 flex-wrap gap-y-1">
                    <span className="flex items-center gap-1.5">
                      {formatDateFR(l.date)} · {formatDureeChrono(l.dureeSec)}
                      {!l.valide && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F0C36B", color: "#5C4300" }}>en attente de validation</span>}
                    </span>
                    <div className="flex items-center gap-2">
                      <span style={{ color: l.valide ? accent.deep : INK_SOFT }}>+{l.points} pts</span>
                      {!l.valide && modeParent && (
                        <>
                          <button onClick={() => validerLecture(l)} className="text-xs px-2 py-1 rounded-md font-semibold text-white" style={{ background: accent.main }}>Valider</button>
                          <button onClick={() => refuserLecture(l)} className="text-xs px-2 py-1 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>Refuser</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Jauge argent de poche */}
          <Card>
            <SectionTitle accent={accent}>Jauge pour gagner son argent de poche</SectionTitle>
            {enfant.jaugeCible > 0 ? (
              <>
                <p className="text-sm font-medium mb-1">{enfant.jaugeLabel}</p>
                <div className="h-2.5 rounded-full bg-black/5 mb-1.5">
                  <div className="h-2.5 rounded-full" style={{ width: `${Math.min(100, (enfant.bonPoints / enfant.jaugeCible) * 100)}%`, background: accent.main }} />
                </div>
                <p className="text-xs mb-2" style={{ color: INK_SOFT }}>{enfant.bonPoints} / {enfant.jaugeCible} points · récompense {formatEUR(enfant.jaugeRecompense)}</p>
                {modeParent && (
                  <>
                    <button onClick={encaisserJauge} disabled={enfant.bonPoints < enfant.jaugeCible}
                      className="text-xs px-3 py-1.5 rounded-md font-semibold text-white disabled:opacity-40" style={{ background: accent.main }}>
                      Encaisser {formatEUR(enfant.jaugeRecompense)}
                    </button>
                    <button onClick={() => updateEnfant({ jaugeCible: 0, jaugeLabel: "", jaugeRecompense: 0 })} className="text-xs px-3 py-1.5 rounded-md font-semibold border ml-2" style={{ borderColor: LINE, color: INK_SOFT }}>
                      Changer d'objectif
                    </button>
                  </>
                )}
              </>
            ) : modeParent ? (
              <div className="flex flex-wrap gap-2 items-end">
                <Field label="Objectif (facultatif)">
                  <input className={inputCls} style={{ borderColor: LINE }} value={jaugeForm.label} onChange={(e) => setJaugeForm({ ...jaugeForm, label: e.target.value })} placeholder="Gagner 5€ pour un jouet" />
                </Field>
                <Field label="Points requis">
                  <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={jaugeForm.cible} onChange={(e) => setJaugeForm({ ...jaugeForm, cible: e.target.value })} />
                </Field>
                <Field label="Récompense (€)">
                  <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={jaugeForm.recompense} onChange={(e) => setJaugeForm({ ...jaugeForm, recompense: e.target.value })} />
                </Field>
                <button onClick={activerJauge} className="h-8 px-3 rounded-md text-sm font-semibold text-white" style={{ background: accent.main }}>Activer</button>
              </div>
            ) : (
              <p className="text-sm" style={{ color: INK_SOFT }}>Aucun objectif défini pour le moment.</p>
            )}
          </Card>

          {/* Tâches ménagères */}
          <Card>
            <SectionTitle accent={accent}>Tâches ménagères &amp; rappels</SectionTitle>
            <p className="text-xs mb-2" style={{ color: INK_SOFT }}>Une tâche validée redevient aussitôt disponible — elle peut être refaite plusieurs fois dans la journée, chaque validation redonne les points.</p>
            <div className="flex flex-col gap-1.5 mb-3">
              {tachesEnfant.map((t) => {
                const enRetard = t.rappelDate && t.rappelDate <= today && t.statut === "a_faire";
                const faitAujourdhui = t.derniereDate === today ? (t.foisAujourdhui || 0) : 0;
                return (
                  <div key={t.id} className="flex items-center justify-between px-2 py-2 rounded-md text-sm flex-wrap gap-y-1"
                    style={{ background: faitAujourdhui > 0 ? accent.soft : t.statut === "en_attente" ? "#FCEFD9" : "transparent" }}>
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <span className="flex items-center justify-center rounded-full text-xl w-10 h-10 shrink-0" style={{ background: "#fff" }}>
                        {emojiTache(t.titre)}
                      </span>
                      <input type="checkbox" checked={t.statut === "en_attente"} onChange={() => marquerFait(t)} className="w-5 h-5" />
                      <span>
                        <span className="block font-medium" style={{ color: INK }}>{t.titre}</span>
                        <span className="text-xs flex items-center gap-1.5 flex-wrap" style={{ color: INK_SOFT }}>
                          <Star size={12} />{t.points} pts
                          {t.statut === "en_attente" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F0C36B", color: "#5C4300" }}>en attente de validation</span>
                          )}
                          {faitAujourdhui > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-1" style={{ background: accent.main, color: "#fff" }}><CheckCircle2 size={10} />fait {faitAujourdhui}× aujourd'hui</span>
                          )}
                          {enRetard && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F3D6D6", color: "#A33B3B" }}>à faire aujourd'hui</span>}
                        </span>
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      {modeParent && t.statut === "en_attente" && (
                        <>
                          <button onClick={() => validerTache(t)} className="text-xs px-2 py-1 rounded-md font-semibold text-white" style={{ background: accent.main }}>Valider</button>
                          <button onClick={() => refuserTache(t)} className="text-xs px-2 py-1 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>Refuser</button>
                        </>
                      )}
                      {modeParent && <button onClick={() => removeTache(t.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>}
                    </div>
                  </div>
                );
              })}
              {!tachesEnfant.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune tâche pour l'instant.</p>}
            </div>
            {modeParent && (
              <>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <button onClick={rattraperTachesDeBase} className="text-xs px-2.5 py-1.5 rounded-md border font-semibold" style={{ borderColor: LINE, color: accent.deep }}>
                    ↻ Harmoniser toutes les tâches entre tous les enfants
                  </button>
                  {!!messageRattrapage && <span className="text-xs font-semibold" style={{ color: accent.deep }}>{messageRattrapage}</span>}
                </div>
                <p className="text-xs font-semibold mb-1.5" style={{ color: INK_SOFT }}>Tâches de base (clic pour ajouter, 5 pts) :</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {TACHES_DE_BASE.map(({ titre, emoji }) => (
                    <button key={titre} onClick={() => addTache(titre, 5)}
                      className="text-xs px-2.5 py-1 rounded-full font-semibold border flex items-center gap-1"
                      style={{ borderColor: LINE, color: accent.deep, background: accent.soft }}>
                      <span className="text-sm">{emoji}</span> {titre}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
                  <Field label="Tâche personnalisée (ajoutée à tous les enfants)">
                    <input className={inputCls} style={{ borderColor: LINE }} value={tacheForm.titre} onChange={(e) => setTacheForm({ ...tacheForm, titre: e.target.value })} placeholder="Autre tâche..." />
                  </Field>
                  <Field label="Points">
                    <input type="number" className={inputCls + " w-20"} style={{ borderColor: LINE }} value={tacheForm.points} onChange={(e) => setTacheForm({ ...tacheForm, points: e.target.value })} />
                  </Field>
                  <Field label="Rappel">
                    <input type="date" className={inputCls} style={{ borderColor: LINE }} value={tacheForm.rappelDate} onChange={(e) => setTacheForm({ ...tacheForm, rappelDate: e.target.value })} />
                  </Field>
                  <button onClick={() => addTache()} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
                </div>
              </>
            )}
          </Card>

          {/* Récompenses */}
          <Card>
            <SectionTitle accent={accent}>Récompenses possibles</SectionTitle>
            <div className="flex flex-col gap-1.5 mb-3">
              {recompensesEnfant.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-2 py-1.5 rounded-md text-sm border" style={{ borderColor: LINE }}>
                  <span className="flex items-center gap-2"><Gift size={14} style={{ color: accent.deep }} />{r.titre} <span className="text-xs" style={{ color: INK_SOFT }}>({r.coutPoints} pts)</span></span>
                  {modeParent && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => echangerRecompense(r)} disabled={enfant.bonPoints < r.coutPoints}
                        className="text-xs px-2.5 py-1 rounded-md font-semibold text-white disabled:opacity-40" style={{ background: accent.main }}>Échanger</button>
                      <button onClick={() => removeRecompense(r.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
                    </div>
                  )}
                </div>
              ))}
              {!recompensesEnfant.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune récompense définie pour l'instant.</p>}
            </div>
            {modeParent && (
              <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
                <Field label="Récompense">
                  <input className={inputCls} style={{ borderColor: LINE }} value={recForm.titre} onChange={(e) => setRecForm({ ...recForm, titre: e.target.value })} placeholder="30 min d'écran en plus" />
                </Field>
                <Field label="Coût (points)">
                  <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={recForm.coutPoints} onChange={(e) => setRecForm({ ...recForm, coutPoints: e.target.value })} />
                </Field>
                <button onClick={addRecompense} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
              </div>
            )}
          </Card>

          {/* Aperçu menu (lecture seule) + idée */}
          <Card>
            <SectionTitle accent={accent}>Les prochains repas</SectionTitle>
            <div className="flex flex-col gap-1 mb-3 max-h-48 overflow-auto pr-1">
              {prochainMenus.map((m) => (
                <div key={m.id} className="text-sm flex justify-between border-b py-1" style={{ borderColor: LINE }}>
                  <span>{m.nom}</span>
                  <span className="text-xs capitalize" style={{ color: INK_SOFT }}>{MOMENT_LABELS[m.moment]} · {m.type} · {formatDateFR(m.date)}</span>
                </div>
              ))}
              {!prochainMenus.length && <p className="text-sm" style={{ color: INK_SOFT }}>Rien de prévu pour le moment.</p>}
            </div>
            <p className="text-xs mb-1.5" style={{ color: INK_SOFT }}>Une idée de repas à proposer ? (les parents décident s'ils l'ajoutent)</p>
            <div className="flex gap-2">
              <input className={inputCls + " flex-1"} style={{ borderColor: LINE }} value={idee} onChange={(e) => setIdee(e.target.value)} placeholder="Ex. des pâtes à la carbonara" />
              <button onClick={envoyerIdee} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Lightbulb size={15} />Proposer</button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PLANNING — agenda familial partagé                                   */
/* ------------------------------------------------------------------ */
function buildGCalLink(ev) {
  const d = new Date(`${ev.date}T${ev.heure || "09:00"}:00`);
  const fin = new Date(d.getTime() + 60 * 60 * 1000);
  const fmt = (dt) => dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.titre,
    dates: `${fmt(d)}/${fmt(fin)}`,
    details: ev.description || "",
  });
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function PlanningTab({ planning, setPlanning, accent }) {
  const [form, setForm] = useState({ titre: "", date: todayISO(), heure: "09:00", pourEnfant: false, description: "" });
  const [filtre, setFiltre] = useState("Tous");

  const addEvent = () => {
    if (!form.titre.trim()) return;
    setPlanning((prev) => [...prev, { id: uid(), ...form }]);
    setForm({ titre: "", date: todayISO(), heure: "09:00", pourEnfant: false, description: "" });
  };
  const removeEvent = (id) => setPlanning((prev) => prev.filter((p) => p.id !== id));

  const filtered = planning
    .filter((p) => filtre === "Tous" || (filtre === "Enfants" ? p.pourEnfant : !p.pourEnfant))
    .slice().sort((a, b) => (a.date + a.heure > b.date + b.heure ? 1 : -1));

  const today = todayISO();

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <Card>
        <SectionTitle accent={accent}>Nouvel évènement</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-2.5 mb-2.5">
          <Field label="Titre">
            <input className={inputCls} style={{ borderColor: LINE }} value={form.titre} onChange={(e) => setForm({ ...form, titre: e.target.value })} placeholder="Rendez-vous, sortie, réunion..." />
          </Field>
          <Field label="Concerne">
            <select className={inputCls} style={{ borderColor: LINE }} value={form.pourEnfant ? "enfant" : "adulte"} onChange={(e) => setForm({ ...form, pourEnfant: e.target.value === "enfant" })}>
              <option value="adulte">Tout le monde / adultes</option>
              <option value="enfant">Enfants</option>
            </select>
          </Field>
          <Field label="Date">
            <input type="date" className={inputCls} style={{ borderColor: LINE }} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Heure">
            <input type="time" className={inputCls} style={{ borderColor: LINE }} value={form.heure} onChange={(e) => setForm({ ...form, heure: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <input className={inputCls} style={{ borderColor: LINE }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optionnel" />
        </Field>
        <button onClick={addEvent} className="mt-3 h-9 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: accent.main }}><Plus size={15} />Ajouter au planning</button>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionTitle accent={accent}>À venir</SectionTitle>
          <div className="flex gap-1.5">
            {["Tous", "Enfants", "Adultes"].map((f) => (
              <button key={f} onClick={() => setFiltre(f)} className="text-xs px-2.5 py-1 rounded-full font-semibold"
                style={{ background: filtre === f ? accent.main : accent.soft, color: filtre === f ? "#fff" : accent.deep }}>{f}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {filtered.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between text-sm py-2 border-b" style={{ borderColor: LINE }}>
              <div>
                <p className="font-medium flex items-center gap-2">
                  {ev.titre}
                  {ev.pourEnfant && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: accent.soft, color: accent.deep }}>enfants</span>}
                  {ev.date === today && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F3D6D6", color: "#A33B3B" }}>aujourd'hui</span>}
                </p>
                <p className="text-xs" style={{ color: INK_SOFT }}>{formatDateFR(ev.date)} à {ev.heure}{ev.description ? ` · ${ev.description}` : ""}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a href={buildGCalLink(ev)} target="_blank" rel="noreferrer" className="text-xs flex items-center gap-1 font-semibold hover:underline" style={{ color: accent.main }}>
                  <ExternalLink size={12} />Google Agenda
                </a>
                <button onClick={() => removeEvent(ev.id)} className="opacity-40 hover:opacity-100"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {!filtered.length && <p className="text-sm" style={{ color: INK_SOFT }}>Rien de prévu pour le moment.</p>}
        </div>
      </Card>
      <p className="text-xs" style={{ color: INK_SOFT }}>
        Le bouton « Google Agenda » ouvre l'évènement pré-rempli dans Google Calendar en un clic (une vraie synchronisation automatique à double sens n'est pas possible depuis cette appli).
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SPORT — mensurations + séances avec catalogue d'exercices           */
/* ------------------------------------------------------------------ */
const DUREES_SPORT = [5, 10, 20, 30, 40, 50, 60, 90, 120];
function labelDuree(min) {
  if (min < 60) return `${min} min`;
  if (min === 60) return "1h";
  if (min === 90) return "1h30";
  return `${Math.floor(min / 60)}h${min % 60 ? min % 60 : ""}`;
}
const DIFFICULTES_SPORT = [
  { key: "facile", label: "Facile", mult: 1 },
  { key: "moyen", label: "Moyen", mult: 1.5 },
  { key: "difficile", label: "Difficile", mult: 2 },
];
const CATEGORIES_SPORT = {
  musculation: {
    label: "Musculation", icon: Dumbbell,
    exercices: [
      { nom: "Soulevé de terre", conseil: "Dos plat, la barre frôle les tibias, pousse le sol avec les jambes en te redressant." },
      { nom: "Développé militaire", conseil: "Gainage serré, pousse la charge à la verticale sans cambrer le bas du dos." },
      { nom: "Pompes explosives (clap)", conseil: "Pousse fort pour décoller les mains du sol, amortis en souplesse à la réception." },
      { nom: "Tractions lestées", conseil: "Ajoute du poids (sac, gilet), monte jusqu'au menton, descente contrôlée." },
      { nom: "Fentes bulgares", conseil: "Pied arrière surélevé, descends jusqu'à 90° au genou avant, garde le buste droit." },
      { nom: "Hip thrust", conseil: "Épaules sur banc, pousse par les talons, serre les fessiers en haut du mouvement." },
      { nom: "Gainage dynamique (mountain climbers)", conseil: "Hanches basses et stables, genoux qui viennent vite vers la poitrine." },
      { nom: "Squats bulgares sautés", conseil: "Explose vers le haut à chaque répétition, atterris en souplesse, genou aligné." },
    ],
  },
  basket: {
    label: "Technique basket (avancé)", icon: Activity,
    exercices: [
      { nom: "Combo crossover + hésitation", conseil: "Change de rythme franchement, vends le move avec les épaules avant l'accélération." },
      { nom: "Euro step en pénétration", conseil: "Deux appuis décalés pour éviter le contact, protège le ballon loin du défenseur." },
      { nom: "Step-back jumper", conseil: "Pousse fort vers l'arrière pour créer l'écart, réceptionne équilibré·e avant de tirer." },
      { nom: "Pull-up jumper en transition", conseil: "Contrôle ta vitesse avant le tir, deux appuis rapides et stables." },
      { nom: "Jeu dos au panier (post moves)", conseil: "Sens la position du défenseur avec le dos, enchaîne feinte puis finition." },
      { nom: "Catch and shoot sous contrainte de temps", conseil: "Prépare tes appuis avant la réception, dégaine en moins d'une seconde." },
      { nom: "Finitions contre contact (through contact)", conseil: "Absorbe le contact avec le corps, protège le ballon des deux mains jusqu'au tir." },
      { nom: "Dribbles combinés (in-and-out, behind the back)", conseil: "Enchaîne sans ralentir, garde le regard relevé sur le terrain." },
    ],
  },
  endurance: {
    label: "Endurance / Fractionné", icon: Wind,
    exercices: [
      { nom: "Course à pied", conseil: "Respiration régulière, foulée courte, allure qu'on peut tenir en discutant." },
      { nom: "Corde à sauter", conseil: "Petits sauts, ce sont les poignets qui tournent la corde, pas les bras." },
      { nom: "Sprints fractionnés (30/30)", conseil: "30s à fond / 30s de récupération, répète en gardant la même intensité." },
      { nom: "Navettes (suicides)", conseil: "Accélère fort sur chaque ligne, touche le sol avec la main avant de repartir." },
      { nom: "Vélo", conseil: "Cadence régulière, dos droit." },
    ],
  },
  detente: {
    label: "Détente / Explosivité (sauts)", icon: Zap,
    exercices: [
      { nom: "Squats sautés", conseil: "Descends en squat puis explose verticalement, atterris en souplesse genoux fléchis." },
      { nom: "Box jumps", conseil: "Élan des bras pour t'aider à monter, réceptionne les deux pieds bien à plat sur la box." },
      { nom: "Fentes sautées (jump lunges)", conseil: "Change de jambe en l'air à chaque saut, garde le buste droit." },
      { nom: "Sauts latéraux (bounds)", conseil: "Pousse fort sur un pied vers le côté, stabilise-toi une seconde avant de repartir." },
      { nom: "Sauts en profondeur (depth jumps)", conseil: "Descends d'une petite hauteur, réceptionne puis rebondis immédiatement le plus haut possible." },
      { nom: "Double-unders (corde à sauter rapide)", conseil: "Fais tourner la corde deux fois par saut, poignets rapides, sauts petits et hauts." },
    ],
  },
};

function SportTab({ sportMembres, setSportMembres, mensurations, setMensurations, seancesSport, setSeancesSport, exercicesPerso, setExercicesPerso, nomActif, onChangerProfil, accent }) {
  const [selectedId, setSelectedId] = useState(sportMembres[0]?.id || null);
  const [newNom, setNewNom] = useState("");
  const [mensuForm, setMensuForm] = useState({ taille: "", poids: "" });
  const [catOuverte, setCatOuverte] = useState("musculation");
  const [seanceForm, setSeanceForm] = useState({ exercice: CATEGORIES_SPORT.musculation.exercices[0].nom, dureeMin: 20, difficulte: "moyen" });
  const [dernierGain, setDernierGain] = useState(null);
  const [nouvelExo, setNouvelExo] = useState({ nom: "", conseil: "" });

  useEffect(() => {
    if (!selectedId && sportMembres.length) setSelectedId(sportMembres[0].id);
  }, [sportMembres]);

  // Espace enfant verrouillé : on cherche (ou crée) le profil sport
  // correspondant au prénom actif, et on verrouille dessus.
  useEffect(() => {
    if (!nomActif) return;
    const existant = sportMembres.find((m) => m.nom.trim().toLowerCase() === nomActif.trim().toLowerCase());
    if (existant) {
      setSelectedId(existant.id);
    } else {
      const nouveau = { id: uid(), nom: nomActif };
      setSportMembres((prev) => [...prev, nouveau]);
      setSelectedId(nouveau.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nomActif]);

  const membre = sportMembres.find((m) => m.id === selectedId);

  // Catalogue affiché = exercices "de base" + ceux ajoutés par la famille pour cette catégorie
  const exercicesCategorie = [
    ...CATEGORIES_SPORT[catOuverte].exercices.map((e) => ({ ...e, perso: false })),
    ...exercicesPerso.filter((e) => e.categorie === catOuverte).map((e) => ({ ...e, perso: true })),
  ];
  const ajouterExercicePerso = () => {
    if (!nouvelExo.nom.trim()) return;
    setExercicesPerso((prev) => [...prev, { id: uid(), categorie: catOuverte, nom: nouvelExo.nom.trim(), conseil: nouvelExo.conseil.trim() }]);
    setNouvelExo({ nom: "", conseil: "" });
  };
  const supprimerExercicePerso = (id) => setExercicesPerso((prev) => prev.filter((e) => e.id !== id));

  const addMembre = () => {
    if (!newNom.trim()) return;
    const m = { id: uid(), nom: newNom.trim() };
    setSportMembres((prev) => [...prev, m]);
    setSelectedId(m.id);
    setNewNom("");
  };
  const removeMembre = (id) => {
    setSportMembres((prev) => prev.filter((m) => m.id !== id));
    setMensurations((prev) => prev.filter((m) => m.membreId !== id));
    setSeancesSport((prev) => prev.filter((s) => s.membreId !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const mensurationsMembre = mensurations.filter((m) => m.membreId === selectedId).sort((a, b) => (a.date > b.date ? 1 : -1));
  const addMensuration = () => {
    if (!mensuForm.taille && !mensuForm.poids) return;
    setMensurations((prev) => [...prev, {
      id: uid(), membreId: selectedId, date: todayISO(),
      taille: mensuForm.taille ? Number(mensuForm.taille) : null,
      poids: mensuForm.poids ? Number(mensuForm.poids) : null,
    }]);
    setMensuForm({ taille: "", poids: "" });
  };
  const removeMensuration = (id) => setMensurations((prev) => prev.filter((m) => m.id !== id));

  const seancesMembre = seancesSport.filter((s) => s.membreId === selectedId).sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalPointsMembre = (id) => seancesSport.filter((s) => s.membreId === id).reduce((sum, s) => sum + s.points, 0);

  const enregistrerSeance = () => {
    if (!membre) return;
    const diff = DIFFICULTES_SPORT.find((d) => d.key === seanceForm.difficulte);
    const points = Math.round(Number(seanceForm.dureeMin) * diff.mult);
    setSeancesSport((prev) => [{
      id: uid(), membreId: selectedId, date: todayISO(),
      categorie: CATEGORIES_SPORT[catOuverte].label, exercice: seanceForm.exercice,
      dureeMin: Number(seanceForm.dureeMin), difficulte: diff.label, points,
    }, ...prev]);
    setDernierGain(points);
    setTimeout(() => setDernierGain(null), 3000);
  };
  const removeSeance = (id) => setSeancesSport((prev) => prev.filter((s) => s.id !== id));

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <Card>
        {nomActif ? (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="px-3 py-1.5 rounded-full text-sm font-semibold" style={{ background: accent.main, color: "#fff" }}>{membre?.nom}</span>
            {onChangerProfil && (
              <button onClick={onChangerProfil} className="text-xs underline" style={{ color: INK_SOFT }}>Ce n'est pas moi</button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {sportMembres.map((m) => (
              <button key={m.id} onClick={() => setSelectedId(m.id)}
                className="px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
                style={{ background: selectedId === m.id ? accent.main : accent.soft, color: selectedId === m.id ? "#fff" : accent.deep }}>
                {m.nom}
              </button>
            ))}
            <input className={inputCls + " w-32"} style={{ borderColor: LINE }} placeholder="Prénom" value={newNom} onChange={(e) => setNewNom(e.target.value)} />
            <button onClick={addMembre} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
          </div>
        )}
      </Card>

      {!nomActif && sportMembres.length >= 2 && (
        <Card>
          <SectionTitle accent={accent}>🏆 Classement sportif de la famille</SectionTitle>
          <div className="flex flex-col gap-2">
            {[...sportMembres].sort((a, b) => totalPointsMembre(b.id) - totalPointsMembre(a.id)).map((m, i) => {
              const titres = ["🔥 Athlète du mois", "🥈 Sacrément en forme", "🥉 Toujours motivé·e"];
              return (
                <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded-md" style={{ background: i === 0 ? accent.soft : "transparent", border: `1px solid ${LINE}` }}>
                  <div className="flex items-center gap-3">
                    <span className="font-serif font-bold text-lg w-6 text-center" style={{ color: accent.deep }}>{i + 1}</span>
                    <div>
                      <p className="font-semibold">{m.nom}</p>
                      <p className="text-xs" style={{ color: INK_SOFT }}>{titres[i] || "⭐ En pleine progression"}</p>
                    </div>
                  </div>
                  <span className="font-serif font-bold flex items-center gap-1" style={{ color: accent.deep }}><Trophy size={15} />{totalPointsMembre(m.id)} pts</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {!membre ? (
        <p className="text-sm" style={{ color: INK_SOFT }}>Ajoute un membre de la famille pour commencer son suivi.</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-serif font-semibold">{membre.nom}</h3>
            <button onClick={() => removeMembre(membre.id)} className="text-xs px-2.5 py-1 rounded-md border font-semibold flex items-center gap-1" style={{ borderColor: LINE, color: INK_SOFT }}><Trash2 size={13} />Supprimer ce profil</button>
          </div>

          {/* Taille / poids */}
          <Card>
            <SectionTitle accent={accent}><Ruler size={14} className="inline mr-1" />Taille &amp; poids</SectionTitle>
            {mensurationsMembre.length > 1 && (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={mensurationsMembre.map((m) => ({ date: formatDateFR(m.date).slice(0, 12), poids: m.poids, taille: m.taille }))}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="poids" stroke={accent.main} name="Poids (kg)" strokeWidth={2} />
                  <Line type="monotone" dataKey="taille" stroke={accent.deep} name="Taille (cm)" strokeWidth={2} strokeDasharray="4 3" />
                </LineChart>
              </ResponsiveContainer>
            )}
            <div className="flex flex-col gap-1 my-3 max-h-32 overflow-auto">
              {mensurationsMembre.slice().reverse().map((m) => (
                <div key={m.id} className="flex items-center justify-between text-sm py-1 border-b" style={{ borderColor: LINE }}>
                  <span>{formatDateFR(m.date)}</span>
                  <div className="flex items-center gap-3">
                    {m.taille && <span>{m.taille} cm</span>}
                    {m.poids && <span>{m.poids} kg</span>}
                    <button onClick={() => removeMensuration(m.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
              {!mensurationsMembre.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune mesure enregistrée.</p>}
            </div>
            <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
              <Field label="Taille (cm)">
                <input type="number" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={mensuForm.taille} onChange={(e) => setMensuForm({ ...mensuForm, taille: e.target.value })} />
              </Field>
              <Field label="Poids (kg)">
                <input type="number" step="0.1" className={inputCls + " w-24"} style={{ borderColor: LINE }} value={mensuForm.poids} onChange={(e) => setMensuForm({ ...mensuForm, poids: e.target.value })} />
              </Field>
              <button onClick={addMensuration} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter (aujourd'hui)</button>
            </div>
          </Card>

          {/* Catalogue d'exercices + log de séance */}
          <Card>
            <SectionTitle accent={accent}>S'entraîner</SectionTitle>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {Object.entries(CATEGORIES_SPORT).map(([key, cat]) => {
                const Icon = cat.icon;
                return (
                  <button key={key} onClick={() => { setCatOuverte(key); setSeanceForm({ ...seanceForm, exercice: cat.exercices[0].nom }); }}
                    className="text-xs px-2.5 py-1.5 rounded-full font-semibold flex items-center gap-1"
                    style={{ background: catOuverte === key ? accent.main : accent.soft, color: catOuverte === key ? "#fff" : accent.deep }}>
                    <Icon size={13} />{cat.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col gap-1.5 mb-3">
              {exercicesCategorie.map((ex) => (
                <label key={ex.id || ex.nom} className="flex items-start justify-between gap-2 px-2.5 py-2 rounded-md cursor-pointer" style={{ background: seanceForm.exercice === ex.nom ? accent.soft : "transparent", border: `1px solid ${LINE}` }}>
                  <div className="flex items-start gap-2">
                    <input type="radio" name="exercice" checked={seanceForm.exercice === ex.nom} onChange={() => setSeanceForm({ ...seanceForm, exercice: ex.nom })} className="mt-1" />
                    <div>
                      <p className="text-sm font-medium flex items-center gap-1.5">
                        {ex.nom}
                        {ex.perso && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: accent.soft, color: accent.deep }}>ajouté</span>}
                      </p>
                      {ex.conseil && <p className="text-xs" style={{ color: INK_SOFT }}>{ex.conseil}</p>}
                    </div>
                  </div>
                  {ex.perso && (
                    <button onClick={(e) => { e.preventDefault(); supprimerExercicePerso(ex.id); }} className="opacity-40 hover:opacity-100 shrink-0"><Trash2 size={13} /></button>
                  )}
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 items-end pt-2 pb-3 border-t border-b mb-3" style={{ borderColor: LINE }}>
              <Field label="Nouvel exercice">
                <input className={inputCls} style={{ borderColor: LINE }} value={nouvelExo.nom} onChange={(e) => setNouvelExo({ ...nouvelExo, nom: e.target.value })} placeholder="Nom de l'exercice" />
              </Field>
              <Field label="Conseil (optionnel)">
                <input className={inputCls + " w-56"} style={{ borderColor: LINE }} value={nouvelExo.conseil} onChange={(e) => setNouvelExo({ ...nouvelExo, conseil: e.target.value })} placeholder="Astuce de posture..." />
              </Field>
              <button onClick={ajouterExercicePerso} className="h-8 px-3 rounded-md text-sm font-semibold border flex items-center gap-1" style={{ borderColor: LINE, color: accent.deep }}><Plus size={15} />Ajouter à "{CATEGORIES_SPORT[catOuverte].label}"</button>
            </div>

            <div className="flex flex-wrap gap-2 items-end pt-2 border-t" style={{ borderColor: LINE }}>
              <Field label="Durée">
                <select className={inputCls} style={{ borderColor: LINE }} value={seanceForm.dureeMin} onChange={(e) => setSeanceForm({ ...seanceForm, dureeMin: Number(e.target.value) })}>
                  {DUREES_SPORT.map((d) => <option key={d} value={d}>{labelDuree(d)}</option>)}
                </select>
              </Field>
              <Field label="Difficulté">
                <select className={inputCls} style={{ borderColor: LINE }} value={seanceForm.difficulte} onChange={(e) => setSeanceForm({ ...seanceForm, difficulte: e.target.value })}>
                  {DIFFICULTES_SPORT.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </Field>
              <button onClick={enregistrerSeance} className="h-9 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: accent.main }}><Flame size={15} />Valider la séance</button>
              {dernierGain !== null && <span className="text-sm font-semibold" style={{ color: accent.deep }}>+{dernierGain} points ! 🎉</span>}
            </div>
          </Card>

          {/* Historique des séances */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <SectionTitle accent={accent}>Historique des séances</SectionTitle>
              <span className="text-sm font-semibold flex items-center gap-1" style={{ color: accent.deep }}><Trophy size={14} />{totalPointsMembre(selectedId)} pts au total</span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-72 overflow-auto">
              {seancesMembre.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm py-1.5 border-b" style={{ borderColor: LINE }}>
                  <div>
                    <p className="font-medium">{s.exercice}</p>
                    <p className="text-xs" style={{ color: INK_SOFT }}>{s.categorie} · {labelDuree(s.dureeMin)} · {s.difficulte} · {formatDateFR(s.date)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold" style={{ color: accent.deep }}>+{s.points} pts</span>
                    <button onClick={() => removeSeance(s.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
              {!seancesMembre.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune séance enregistrée pour l'instant.</p>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TODO — liste solo ou partagée                                       */
/* ------------------------------------------------------------------ */
function TodoTab({ todos, setTodos, accent }) {
  const [titre, setTitre] = useState("");
  const [partage, setPartage] = useState(false);
  const [filtre, setFiltre] = useState("Tous");

  const addTodo = () => {
    if (!titre.trim()) return;
    setTodos([{ id: uid(), titre: titre.trim(), partage, fait: false }, ...todos]);
    setTitre("");
  };
  const toggle = (id) => setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, fait: !t.fait } : t)));
  const remove = (id) => setTodos((prev) => prev.filter((t) => t.id !== id));

  const filtered = todos.filter((t) => filtre === "Tous" || (filtre === "Solo" ? !t.partage : t.partage));

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <Card>
        <div className="flex flex-wrap gap-2 items-end">
          <Field label="Nouvelle tâche">
            <input className={inputCls + " w-56"} style={{ borderColor: LINE }} value={titre} onChange={(e) => setTitre(e.target.value)} placeholder="Appeler le médecin..." />
          </Field>
          <Field label="Visibilité">
            <select className={inputCls} style={{ borderColor: LINE }} value={partage ? "partage" : "solo"} onChange={(e) => setPartage(e.target.value === "partage")}>
              <option value="solo">Solo</option>
              <option value="partage">Partagé (famille)</option>
            </select>
          </Field>
          <button onClick={addTodo} className="h-8 px-3 rounded-md text-sm font-semibold text-white flex items-center gap-1" style={{ background: accent.main }}><Plus size={15} />Ajouter</button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionTitle accent={accent}>Liste ({filtered.length})</SectionTitle>
          <div className="flex gap-1.5">
            {["Tous", "Solo", "Partagé"].map((f) => (
              <button key={f} onClick={() => setFiltre(f)} className="text-xs px-2.5 py-1 rounded-full font-semibold"
                style={{ background: filtre === f ? accent.main : accent.soft, color: filtre === f ? "#fff" : accent.deep }}>{f}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {filtered.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-2 py-1.5 rounded-md text-sm" style={{ background: t.fait ? accent.soft : "transparent" }}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={t.fait} onChange={() => toggle(t.id)} className="w-4 h-4" />
                <span style={{ textDecoration: t.fait ? "line-through" : "none" }}>{t.titre}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: t.partage ? accent.main : "transparent", color: t.partage ? "#fff" : INK_SOFT, border: t.partage ? "none" : `1px solid ${LINE}` }}>
                  {t.partage ? "partagé" : "solo"}
                </span>
              </label>
              <button onClick={() => remove(t.id)} className="opacity-40 hover:opacity-100"><Trash2 size={14} /></button>
            </div>
          ))}
          {!filtered.length && <p className="text-sm" style={{ color: INK_SOFT }}>Rien à faire pour l'instant.</p>}
        </div>
      </Card>
    </div>
  );
}
