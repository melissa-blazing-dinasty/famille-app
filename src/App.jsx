import { useState, useEffect, useMemo, useRef } from "react";
import {
  Wallet, CalendarDays, BookOpen, Plus, Trash2, X, Search,
  Upload, TrendingUp, TrendingDown, Link as LinkIcon,
  PiggyBank, Baby, Calendar, ListChecks, Star, Gift, ExternalLink, CheckCircle2, Lightbulb, Bell, Lock, Unlock, Minus
} from "lucide-react";
import Papa from "papaparse";
import { db, ensureSignedIn } from "./firebase.js";
import { doc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */
const PAPER = "#F6F1E7";
const PAPER_DARK = "#EFE7D8";
const INK = "#332F28";
const INK_SOFT = "#6B6357";
const TAN = "#CBA876";
const LINE = "#DCD0B8";

const ACCENTS = {
  budget: { main: "#5F7A5A", soft: "#E4EBDF", deep: "#425840" },
  menus: { main: "#C17A3B", soft: "#F5E4D2", deep: "#8C5527" },
  recettes: { main: "#8A4A66", soft: "#F0DEE6", deep: "#63324A" },
  epargne: { main: "#3E7C74", soft: "#DCEAE7", deep: "#275F58" },
  enfants: { main: "#C99A2E", soft: "#F5EBD2", deep: "#8F6B18" },
  planning: { main: "#4C5B8C", soft: "#E1E4F0", deep: "#333F66" },
  todo: { main: "#5A6570", soft: "#E7EAEC", deep: "#3C444C" },
};

const DEFAULT_CATEGORIES = ["Alimentation", "Logement", "Transport", "Loisirs", "Santé", "Enfants", "Autres"];
const TYPES_PLAT = ["Entrée", "Plat", "Dessert", "Goûter"];
const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function uid() { return Math.random().toString(36).slice(2, 10); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
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
async function saveKeyFS(familyCode, key, value) {
  try {
    await setDoc(keyDocRef(familyCode, key), { value, updatedAt: serverTimestamp() });
  } catch (e) {
    console.error("Erreur de sauvegarde", key, e);
  }
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
      (err) => { console.error("Erreur de lecture", key, err); setReady(true); }
    );
    return () => unsub();
  }, [familyCode, authReady, key]);

  const setValue = (updater) => {
    setValueState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const nextStr = JSON.stringify(next);
      if (nextStr !== lastKnown.current) {
        lastKnown.current = nextStr;
        saveKeyFS(familyCode, key, next);
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
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) onValidate(code.trim()); }}
        />
        <button
          onClick={() => code.trim() && onValidate(code.trim())}
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
  const [familyCode, setFamilyCode] = useState(() => localStorage.getItem("familyCode") || "");
  const [authReady, setAuthReady] = useState(false);

  // Connexion anonyme Firebase (une fois, avant tout accès Firestore)
  useEffect(() => { ensureSignedIn().then(() => setAuthReady(true)); }, []);

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
  const loaded = r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r16 && r17 && r18;

  useNotifierDuJour(taches, planning);

  if (!familyCode) {
    return <FamilyCodeGate onValidate={(code) => { localStorage.setItem("familyCode", code); setFamilyCode(code); }} />;
  }

  const tabs = [
    { id: "budget", label: "Budget", icon: Wallet, accent: ACCENTS.budget },
    { id: "epargne", label: "Épargne", icon: PiggyBank, accent: ACCENTS.epargne },
    { id: "menus", label: "Menus", icon: CalendarDays, accent: ACCENTS.menus },
    { id: "recettes", label: "Recettes", icon: BookOpen, accent: ACCENTS.recettes },
    { id: "enfants", label: "Enfants", icon: Baby, accent: ACCENTS.enfants },
    { id: "planning", label: "Planning", icon: Calendar, accent: ACCENTS.planning },
    { id: "todo", label: "À faire", icon: ListChecks, accent: ACCENTS.todo },
  ];
  const active = tabs.find((t) => t.id === tab);

  return (
    <div className="min-h-screen w-full flex flex-col sm:flex-row" style={{ background: PAPER, color: INK, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* Onglets style classeur */}
      <nav className="flex sm:flex-col shrink-0 sm:w-20 border-b sm:border-b-0 sm:border-r overflow-x-auto sm:overflow-y-auto" style={{ borderColor: LINE }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex-1 sm:flex-none flex sm:flex-col items-center justify-center gap-1.5 py-4 sm:py-6 transition-all relative focus:outline-none"
              style={{
                background: isActive ? t.accent.main : "transparent",
                color: isActive ? "#fff" : INK_SOFT,
              }}
            >
              <Icon size={20} strokeWidth={1.75} />
              <span className="text-[11px] font-semibold tracking-wide" style={{ writingMode: "horizontal-tb" }}>{t.label}</span>
            </button>
          );
        })}
      </nav>

      <main className="flex-1 min-w-0">
        <header className="px-5 sm:px-8 py-5 border-b" style={{ borderColor: LINE, background: PAPER_DARK }}>
          <p className="text-[11px] uppercase tracking-[0.2em] font-semibold" style={{ color: active.accent.main }}>Carnet de famille</p>
          <h1 className="text-2xl sm:text-3xl font-serif font-semibold mt-0.5" style={{ color: INK }}>{active.label}</h1>
        </header>
        <div className="px-5 sm:px-8 py-6">
          {!loaded ? (
            <p className="text-sm" style={{ color: INK_SOFT }}>Chargement des données…</p>
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
            <MenusTab menus={menus} setMenus={setMenus} recettes={recettes} accent={ACCENTS.menus}
              menuIdees={menuIdees} setMenuIdees={setMenuIdees} enfants={enfants} />
          ) : tab === "recettes" ? (
            <RecettesTab recettes={recettes} setRecettes={setRecettes} menus={menus} accent={ACCENTS.recettes} />
          ) : tab === "epargne" ? (
            <EpargneTab epargnes={epargnes} setEpargnes={setEpargnes} accent={ACCENTS.epargne} />
          ) : tab === "enfants" ? (
            <EnfantsTab
              enfants={enfants} setEnfants={setEnfants}
              taches={taches} setTaches={setTaches}
              recompenses={recompenses} setRecompenses={setRecompenses}
              menus={menus} menuIdees={menuIdees} setMenuIdees={setMenuIdees}
              parentPin={parentPin} setParentPin={setParentPin}
              accent={ACCENTS.enfants}
            />
          ) : tab === "planning" ? (
            <PlanningTab planning={planning} setPlanning={setPlanning} accent={ACCENTS.planning} />
          ) : (
            <TodoTab todos={todos} setTodos={setTodos} accent={ACCENTS.todo} />
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
  const [form, setForm] = useState({ libelle: "", type: "depense", montant: "", compte: "", date: "" });

  useEffect(() => {
    if (!form.compte && comptes.length) setForm((f) => ({ ...f, compte: comptes[0].nom }));
  }, [comptes]);

  const addLigne = () => {
    if (!form.libelle.trim() || !form.montant) return;
    setBaseMensuelle([...baseMensuelle, { id: uid(), ...form, montant: Number(form.montant), fait: false }]);
    setForm({ ...form, libelle: "", montant: "", date: "" });
  };
  const removeLigne = (id) => setBaseMensuelle(baseMensuelle.filter((l) => l.id !== id));
  const toggleLigne = (id) => setBaseMensuelle(baseMensuelle.map((l) => (l.id === id ? { ...l, fait: !l.fait } : l)));
  const setDateLigne = (id, date) => setBaseMensuelle(baseMensuelle.map((l) => (l.id === id ? { ...l, date } : l)));
  const resetTout = () => setBaseMensuelle(baseMensuelle.map((l) => ({ ...l, fait: false })));

  const totalDepenses = baseMensuelle.filter((l) => l.type === "depense").reduce((s, l) => s + l.montant, 0);
  const totalRevenus = baseMensuelle.filter((l) => l.type === "revenu").reduce((s, l) => s + l.montant, 0);
  // "Réel à ce jour" : seulement ce qui est vraiment coché comme fait
  const totalRevenusEncaisses = baseMensuelle.filter((l) => l.type === "revenu" && l.fait).reduce((s, l) => s + l.montant, 0);
  const totalDepensesPrelevees = baseMensuelle.filter((l) => l.type === "depense" && l.fait).reduce((s, l) => s + l.montant, 0);
  const today = todayISO();

  return (
    <Card>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <SectionTitle accent={accent}>Base mensuelle — charges fixes &amp; salaires</SectionTitle>
        <button onClick={resetTout} className="text-xs px-2.5 py-1 rounded-md border font-semibold" style={{ borderColor: LINE, color: INK_SOFT }}>
          Réinitialiser les cases (nouveau mois)
        </button>
      </div>
      <p className="text-xs mb-3" style={{ color: INK_SOFT }}>
        Ta base récurrente : loyer, crédits, abonnements, salaires... Coche une ligne (et note la date si tu veux) dès qu'elle est prélevée ou que l'argent est arrivé — la ligne passe en bleu clair, et ça alimente le "solde réel à ce jour" en bas.
      </p>

      <div className="flex flex-col gap-1 mb-3">
        {/* en-tête */}
        <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-2 text-[11px] font-semibold uppercase tracking-wide px-2" style={{ color: INK_SOFT }}>
          <span className="w-5"></span>
          <span>Libellé</span>
          <span>Compte</span>
          <span>Date</span>
          <span className="text-right">Montant</span>
          <span></span>
        </div>
        {baseMensuelle.map((l) => {
          const enRetard = l.date && l.date < today && !l.fait;
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
              <input type="date" value={l.date || ""} onChange={(e) => setDateLigne(l.id, e.target.value)}
                className="text-xs border rounded px-1 py-0.5" style={{ borderColor: LINE, background: l.fait ? "#fff" : "transparent" }} />
              <span className="text-right font-semibold flex items-center gap-1 justify-end" style={{ color: l.fait ? CHECKED_BLUE_TEXT : (l.type === "revenu" ? accent.deep : "#A33B3B") }}>
                {l.type === "revenu" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {formatEUR(l.montant)}
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
        <Field label="Date prévue">
          <input type="date" className={inputCls} style={{ borderColor: LINE }} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
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
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* BUDGET                                                               */
/* ------------------------------------------------------------------ */
function BudgetTab({ comptes, setComptes, transactions, setTransactions, categories, setCategories, baseMensuelle, setBaseMensuelle, budgetQuotidien, setBudgetQuotidien, decouvert, setDecouvert, extrasImprevus, setExtrasImprevus, courses, setCourses, epargnes, setEpargnes, accent }) {
  const [newCompte, setNewCompte] = useState("");
  const [newSolde, setNewSolde] = useState("0");
  const [form, setForm] = useState({ date: todayISO(), compte: "", categorie: categories[0] || "", type: "depense", montant: "", description: "" });
  const [newCat, setNewCat] = useState("");
  const [monthFilter, setMonthFilter] = useState(todayISO().slice(0, 7));

  // --- Suivi avancé (basé sur le fichier Excel d'origine) ---
  const [quotForm, setQuotForm] = useState({ categorie: "", prevu: "" });
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
    setBaseMensuelle([...baseMensuelle, ...nouvellesBase]);

    setBudgetQuotidien([...budgetQuotidien,
      { id: uid(), categorie: "Alimentation", prevu: 1100 },
      { id: uid(), categorie: "Essence", prevu: 500 },
      { id: uid(), categorie: "epilation", prevu: 25 },
    ]);

    setEpargnes([...epargnes,
      { id: uid(), theme: "Timéo", objectif: 300, montant: 300 },
      { id: uid(), theme: "Léoni", objectif: 264, montant: 264 },
      { id: uid(), theme: "Leandro", objectif: 240, montant: 240 },
    ]);

    setCourses([...courses,
      { id: uid(), achat: "Courses", montant: 365, date: todayISO() },
      { id: uid(), achat: "courses", montant: 249, date: todayISO() },
      { id: uid(), achat: "spart (courses)", montant: 66, date: todayISO() },
    ]);

    setExtrasImprevus([...extrasImprevus,
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
      .filter((t) => t.compte === nomCompte)
      .reduce((s, t) => s + (t.type === "revenu" ? Number(t.montant) : -Number(t.montant)), 0);
    return base + delta;
  };
  const soldeTotal = comptes.reduce((s, c) => s + soldeCompte(c.nom), 0);

  const addCompte = () => {
    if (!newCompte.trim()) return;
    setComptes([...comptes, { id: uid(), nom: newCompte.trim(), solde: Number(newSolde) || 0 }]);
    setNewCompte(""); setNewSolde("0");
  };
  const removeCompte = (id) => {
    const c = comptes.find((c) => c.id === id);
    setComptes(comptes.filter((c) => c.id !== id));
    if (c) setTransactions(transactions.filter((t) => t.compte !== c.nom));
  };
  const addTransaction = () => {
    if (!form.compte || !form.montant) return;
    setTransactions([{ id: uid(), ...form, montant: Number(form.montant) }, ...transactions]);
    setForm({ ...form, montant: "", description: "" });
  };
  const removeTransaction = (id) => setTransactions(transactions.filter((t) => t.id !== id));
  const addCategorie = () => {
    if (!newCat.trim() || categories.includes(newCat.trim())) return;
    setCategories([...categories, newCat.trim()]);
    setNewCat("");
  };

  const monthTx = transactions.filter((t) => t.date.slice(0, 7) === monthFilter);
  const parCategorie = useMemo(() => {
    const map = {};
    monthTx.filter((t) => t.type === "depense").forEach((t) => { map[t.categorie] = (map[t.categorie] || 0) + Number(t.montant); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [monthTx]);
  const maxCat = Math.max(1, ...parCategorie.map(([, v]) => v));

  // --- Le Quotidien : budget prévu par catégorie ---
  const addQuot = () => {
    if (!quotForm.categorie.trim() || !quotForm.prevu) return;
    setBudgetQuotidien([...budgetQuotidien, { id: uid(), categorie: quotForm.categorie.trim(), prevu: Number(quotForm.prevu) || 0 }]);
    setQuotForm({ categorie: "", prevu: "" });
  };
  const removeQuot = (id) => setBudgetQuotidien(budgetQuotidien.filter((q) => q.id !== id));
  const reelParCategorieMap = Object.fromEntries(parCategorie);
  const totalQuotidienPrevu = budgetQuotidien.reduce((s, q) => s + q.prevu, 0);
  const totalQuotidienReel = budgetQuotidien.reduce((s, q) => s + (reelParCategorieMap[q.categorie] || 0), 0);

  // --- Suivi du découvert ---
  const decouvertRestant = Math.max(0, (decouvert.debutMois || 0) - (decouvert.rembourseCeMois || 0));

  // --- Suivi courses (cumul) ---
  const addCourse = () => {
    if (!courseForm.achat.trim() || !courseForm.montant) return;
    setCourses([{ id: uid(), achat: courseForm.achat.trim(), montant: Number(courseForm.montant) || 0, date: todayISO() }, ...courses]);
    setCourseForm({ achat: "", montant: "" });
  };
  const removeCourse = (id) => setCourses(courses.filter((c) => c.id !== id));
  const totalCourses = courses.reduce((s, c) => s + c.montant, 0);
  const budgetAlimentation = budgetQuotidien.find((q) => q.categorie.toLowerCase().includes("aliment"))?.prevu || 0;
  const resteDisponibleCourses = budgetAlimentation - totalCourses;

  // --- Extras & imprévus hors budget ---
  const addExtra = () => {
    if (!extraForm.poste.trim() || !extraForm.montant) return;
    setExtrasImprevus([{ id: uid(), poste: extraForm.poste.trim(), montant: Number(extraForm.montant) || 0, type: extraForm.type, date: todayISO() }, ...extrasImprevus]);
    setExtraForm({ poste: "", montant: "", type: "extra" });
  };
  const removeExtra = (id) => setExtrasImprevus(extrasImprevus.filter((e) => e.id !== id));
  const totalExtras = extrasImprevus.filter((e) => e.type === "extra").reduce((s, e) => s + e.montant, 0);
  const totalImprevus = extrasImprevus.filter((e) => e.type === "imprevu").reduce((s, e) => s + e.montant, 0);

  // --- Vue d'ensemble (mêmes formules que le fichier Excel d'origine) ---
  const totalRentrees = baseMensuelle.filter((l) => l.type === "revenu").reduce((s, l) => s + l.montant, 0);
  const totalDepensesFixes = baseMensuelle.filter((l) => l.type === "depense").reduce((s, l) => s + l.montant, 0);
  const resteTheorique = totalRentrees - totalDepensesFixes - totalQuotidienPrevu;
  const resteReelApresDecouvert = resteTheorique - (decouvert.rembourseCeMois || 0);
  const resteDisponibleGlobal = resteReelApresDecouvert - totalExtras - totalImprevus;
  // Où j'en suis VRAIMENT à ce jour : seulement ce qui est coché comme reçu/prélevé + les dépenses réellement engagées (courses, extras)
  const totalRevenusEncaisses = baseMensuelle.filter((l) => l.type === "revenu" && l.fait).reduce((s, l) => s + l.montant, 0);
  const totalDepensesPreleveesGlobal = baseMensuelle.filter((l) => l.type === "depense" && l.fait).reduce((s, l) => s + l.montant, 0);
  const soldeReelAJour = totalRevenusEncaisses - totalDepensesPreleveesGlobal - totalCourses - totalExtras - totalImprevus;

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
      if (comptesManquants.length) setComptes([...comptes, ...comptesManquants]);
      setTransactions([...nouvelles, ...transactions]);
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

      <BaseMensuelleCard
        baseMensuelle={baseMensuelle} setBaseMensuelle={setBaseMensuelle}
        comptes={comptes} accent={accent}
      />

      {/* Comptes */}
      <Card>
        <SectionTitle accent={accent}>Comptes</SectionTitle>
        <div className="flex flex-wrap gap-2 mb-3">
          {comptes.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full text-sm" style={{ background: accent.soft, color: accent.deep }}>
              {c.nom}
              <button onClick={() => removeCompte(c.id)} className="hover:opacity-70"><X size={13} /></button>
            </span>
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
          <input className={inputCls + " flex-1 max-w-[180px]"} style={{ borderColor: LINE }} placeholder="Nouvelle catégorie" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button onClick={addCategorie} className="text-xs px-2.5 py-1.5 rounded-md border font-semibold" style={{ borderColor: LINE, color: accent.deep }}>+ Catégorie</button>
          <div className="flex-1" />
          <button onClick={addTransaction} disabled={!comptes.length} className="h-9 px-4 rounded-md text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-40" style={{ background: accent.main }}><Plus size={15} />Enregistrer</button>
        </div>
      </Card>

      {/* Répartition + historique */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionTitle accent={accent}>Répartition par catégorie</SectionTitle>
            <input type="month" className="text-xs border rounded-md px-2 py-1" style={{ borderColor: LINE }} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
          </div>
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
            {transactions.slice(0, 40).map((t) => (
              <div key={t.id} className="flex items-center justify-between text-sm py-1 border-b" style={{ borderColor: LINE }}>
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.description || t.categorie}</p>
                  <p className="text-xs" style={{ color: INK_SOFT }}>{t.date} · {t.compte} · {t.categorie}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-semibold flex items-center gap-1" style={{ color: t.type === "revenu" ? accent.deep : "#A33B3B" }}>
                    {t.type === "revenu" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {formatEUR(t.montant)}
                  </span>
                  <button onClick={() => removeTransaction(t.id)} className="opacity-40 hover:opacity-100"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
            {!transactions.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucune transaction pour le moment.</p>}
          </div>
        </Card>
      </div>

      {/* Vue d'ensemble */}
      <div className="rounded-lg p-5" style={{ background: accent.soft }}>
        <p className="text-xs uppercase tracking-wide font-semibold mb-2" style={{ color: accent.deep }}>Vue d'ensemble du mois</p>
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


      <div className="grid md:grid-cols-2 gap-6">
        {/* Le Quotidien : budget prévu vs réel */}
        <Card>
          <SectionTitle accent={accent}>Le Quotidien — prévu vs réel</SectionTitle>
          <div className="flex flex-col gap-2 mb-3">
            {budgetQuotidien.map((q) => {
              const reel = reelParCategorieMap[q.categorie] || 0;
              const reste = q.prevu - reel;
              return (
                <div key={q.id} className="text-sm">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="font-medium">{q.categorie}</span>
                    <div className="flex items-center gap-2">
                      <span style={{ color: INK_SOFT }}>{formatEUR(reel)} / {formatEUR(q.prevu)}</span>
                      <button onClick={() => removeQuot(q.id)} className="opacity-40 hover:opacity-100"><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-black/5"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, (reel / (q.prevu || 1)) * 100)}%`, background: reste < 0 ? "#A33B3B" : accent.main }} /></div>
                  <p className="text-xs mt-0.5" style={{ color: reste < 0 ? "#A33B3B" : INK_SOFT }}>reste {formatEUR(reste)}</p>
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

function MomentRow({ label, date, moment, types, getEntry, setEntry, recettes, accent, single }) {
  return (
    <div className="rounded-md p-2.5" style={{ background: accent.soft }}>
      <p className="text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: accent.deep }}>{label}</p>
      <div className={`grid gap-2 ${single ? "grid-cols-1 max-w-xs" : "grid-cols-1 sm:grid-cols-3"}`}>
        {types.map((type) => {
          const entry = getEntry(date, moment, type);
          const listId = `list-${moment}-${type}`;
          return (
            <div key={type}>
              {!single && <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: INK_SOFT }}>{type}</p>}
              <input
                list={listId}
                className="w-full border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none"
                style={{ borderColor: LINE }}
                defaultValue={entry ? entry.nom : ""}
                placeholder="—"
                onBlur={(e) => setEntry(date, moment, type, e.target.value)}
              />
              <datalist id={listId}>
                {recettes.filter((r) => r.type === type).map((r) => <option key={r.id} value={r.nom} />)}
              </datalist>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MENUS                                                                */
/* ------------------------------------------------------------------ */
function MenusTab({ menus, setMenus, recettes, accent, menuIdees, setMenuIdees, enfants }) {
  const [start, setStart] = useState(todayISO());
  const [duree, setDuree] = useState(7);
  const [filtreType, setFiltreType] = useState("Tous");
  const [view, setView] = useState("planning");

  const jours = useMemo(() => {
    const arr = [];
    const d0 = new Date(start + "T00:00:00");
    for (let i = 0; i < duree; i++) {
      const d = new Date(d0); d.setDate(d0.getDate() + i);
      arr.push(d.toISOString().slice(0, 10));
    }
    return arr;
  }, [start, duree]);

  const getEntry = (date, moment, type) => menus.find((m) => m.date === date && m.moment === moment && m.type === type);
  const setEntry = (date, moment, type, nom) => {
    const existing = getEntry(date, moment, type);
    if (!nom.trim()) {
      if (existing) setMenus(menus.filter((m) => m.id !== existing.id));
      return;
    }
    if (existing) setMenus(menus.map((m) => (m.id === existing.id ? { ...m, nom } : m)));
    else setMenus([...menus, { id: uid(), date, moment, type, nom }]);
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

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex flex-wrap gap-2">
        {["planning", "historique"].map((v) => (
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

          <div className="flex flex-col gap-3">
            {jours.map((date) => (
              <Card key={date}>
                <p className="font-serif font-semibold capitalize mb-3" style={{ color: accent.deep }}>{formatDateFR(date)}</p>
                <div className="flex flex-col gap-3">
                  <MomentRow label="Midi" date={date} moment="midi" types={["Entrée", "Plat", "Dessert"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} />
                  <MomentRow label="Goûter" date={date} moment="gouter" types={["Goûter"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} single />
                  <MomentRow label="Soir" date={date} moment="soir" types={["Entrée", "Plat", "Dessert"]} getEntry={getEntry} setEntry={setEntry} recettes={recettes} accent={accent} />
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : (
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
                  <p className="text-xs capitalize" style={{ color: INK_SOFT }}>{MOMENT_LABELS[m.moment] || ""} · {m.type} · {formatDateFR(m.date)}</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: accent.soft, color: accent.deep }}>
                  utilisé {compteUsage[m.nom] || 1}×
                </span>
              </div>
            ))}
            {!historique.length && <p className="text-sm" style={{ color: INK_SOFT }}>Aucun menu enregistré pour l'instant.</p>}
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
                  <button onClick={() => setMenuIdees(menuIdees.filter((i) => i.id !== idee.id))} className="opacity-40 hover:opacity-100 shrink-0"><Trash2 size={14} /></button>
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
function RecettesTab({ recettes, setRecettes, menus, accent }) {
  const [form, setForm] = useState({ nom: "", type: TYPES_PLAT[1], lien: "", texte: "" });
  const [search, setSearch] = useState("");
  const [filtreType, setFiltreType] = useState("Tous");
  const [openId, setOpenId] = useState(null);

  const compteUsage = useMemo(() => {
    const map = {};
    menus.forEach((m) => { map[m.nom] = (map[m.nom] || 0) + 1; });
    return map;
  }, [menus]);

  const addRecette = () => {
    if (!form.nom.trim()) return;
    setRecettes([{ id: uid(), ...form, date: todayISO() }, ...recettes]);
    setForm({ nom: "", type: TYPES_PLAT[1], lien: "", texte: "" });
  };
  const removeRecette = (id) => setRecettes(recettes.filter((r) => r.id !== id));

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
              {r.texte && (
                <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-xs mt-1.5 font-semibold" style={{ color: accent.deep }}>
                  {openId === r.id ? "Masquer la recette" : "Voir la recette"}
                </button>
              )}
              {openId === r.id && <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: INK }}>{r.texte}</p>}
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
    setEpargnes([...epargnes, { id: uid(), theme: form.theme.trim(), objectif: Number(form.objectif), montant: 0 }]);
    setForm({ theme: "", objectif: "" });
  };
  const removeTheme = (id) => setEpargnes(epargnes.filter((e) => e.id !== id));
  const verser = (id, sens) => {
    const val = Number(montants[id] || 0);
    if (!val) return;
    setEpargnes(epargnes.map((e) => (e.id === id ? { ...e, montant: Math.max(0, e.montant + sens * val) } : e)));
    setMontants({ ...montants, [id]: "" });
  };

  const totalEpargne = epargnes.reduce((s, e) => s + e.montant, 0);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="rounded-lg p-5" style={{ background: accent.soft }}>
        <p className="text-xs uppercase tracking-wide font-semibold" style={{ color: accent.deep }}>Total épargné, tous thèmes confondus</p>
        <p className="text-3xl font-serif font-bold" style={{ color: accent.deep }}>{formatEUR(totalEpargne)}</p>
      </div>

      <Card>
        <SectionTitle accent={accent}>Nouveau thème d'épargne</SectionTitle>
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
              <p className="text-sm mb-3" style={{ color: INK_SOFT }}>{formatEUR(e.montant)} / {formatEUR(e.objectif)} ({Math.round(pct)}%)</p>
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

function EnfantsTab({ enfants, setEnfants, taches, setTaches, recompenses, setRecompenses, menus, menuIdees, setMenuIdees, parentPin, setParentPin, accent }) {
  const [selectedId, setSelectedId] = useState(enfants[0]?.id || null);
  const [newPrenom, setNewPrenom] = useState("");
  const [tacheForm, setTacheForm] = useState({ titre: "", points: 5, rappelDate: "" });
  const [recForm, setRecForm] = useState({ titre: "", coutPoints: 20 });
  const [idee, setIdee] = useState("");
  const [ajustePoche, setAjustePoche] = useState("");
  const [ajustePoints, setAjustePoints] = useState("");
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

  const addEnfant = () => {
    if (!newPrenom.trim()) return;
    const e = { id: uid(), prenom: newPrenom.trim(), soldePoche: 0, bonPoints: 0, jaugeLabel: "", jaugeCible: 0, jaugeRecompense: 0 };
    setEnfants([...enfants, e]);
    setSelectedId(e.id);
    setNewPrenom("");
  };
  const removeEnfant = (id) => {
    setEnfants(enfants.filter((e) => e.id !== id));
    setTaches(taches.filter((t) => t.enfantId !== id));
    setRecompenses(recompenses.filter((r) => r.enfantId !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const updateEnfant = (patch) => setEnfants(enfants.map((e) => (e.id === selectedId ? { ...e, ...patch } : e)));

  const ajusterSolde = (sens) => {
    const val = Number(ajustePoche || 0);
    if (!val || !enfant) return;
    updateEnfant({ soldePoche: Math.max(0, enfant.soldePoche + sens * val) });
    setAjustePoche("");
  };

  const ajusterPoints = (sens) => {
    const val = Number(ajustePoints || 0);
    if (!val || !enfant) return;
    updateEnfant({ bonPoints: Math.max(0, enfant.bonPoints + sens * val) });
    setAjustePoints("");
  };

  const tachesEnfant = taches.filter((t) => t.enfantId === selectedId);
  const addTache = (titre, points) => {
    if (!(titre || tacheForm.titre).trim() || !enfant) return;
    setTaches([...taches, {
      id: uid(), enfantId: selectedId,
      titre: (titre || tacheForm.titre).trim(),
      points: Number(points ?? tacheForm.points) || 0,
      rappelDate: titre ? "" : tacheForm.rappelDate,
      statut: "a_faire", // a_faire -> en_attente (côté enfant) -> valide (côté parent, donne les points)
    }]);
    if (!titre) setTacheForm({ titre: "", points: 5, rappelDate: "" });
  };
  const removeTache = (id) => setTaches(taches.filter((t) => t.id !== id));
  // Action enfant : signaler que la tâche est faite → passe "en attente de validation".
  // Ne donne aucun point tant qu'un parent n'a pas validé.
  const marquerFait = (t) => {
    setTaches(taches.map((x) => (x.id === t.id ? { ...x, statut: x.statut === "a_faire" ? "en_attente" : "a_faire" } : x)));
  };
  // Actions parent uniquement : valider donne les points, refuser renvoie la tâche à faire.
  const validerTache = (t) => {
    setTaches(taches.map((x) => (x.id === t.id ? { ...x, statut: "valide" } : x)));
    updateEnfant({ bonPoints: enfant.bonPoints + t.points });
  };
  const refuserTache = (t) => {
    setTaches(taches.map((x) => (x.id === t.id ? { ...x, statut: "a_faire" } : x)));
  };

  const recompensesEnfant = recompenses.filter((r) => r.enfantId === selectedId);
  const addRecompense = () => {
    if (!recForm.titre.trim() || !enfant) return;
    setRecompenses([...recompenses, { id: uid(), enfantId: selectedId, titre: recForm.titre.trim(), coutPoints: Number(recForm.coutPoints) || 0 }]);
    setRecForm({ titre: "", coutPoints: 20 });
  };
  const removeRecompense = (id) => setRecompenses(recompenses.filter((r) => r.id !== id));
  const echangerRecompense = (r) => {
    if (!enfant || enfant.bonPoints < r.coutPoints) return;
    updateEnfant({ bonPoints: enfant.bonPoints - r.coutPoints });
  };

  const activerJauge = () => {
    if (!jaugeForm.label.trim() || !enfant) return;
    updateEnfant({ jaugeLabel: jaugeForm.label.trim(), jaugeCible: Number(jaugeForm.cible) || 0, jaugeRecompense: Number(jaugeForm.recompense) || 0 });
    setJaugeForm({ label: "", cible: 50, recompense: 5 });
  };
  const encaisserJauge = () => {
    if (!enfant || enfant.bonPoints < enfant.jaugeCible) return;
    updateEnfant({ soldePoche: enfant.soldePoche + enfant.jaugeRecompense, bonPoints: enfant.bonPoints - enfant.jaugeCible });
  };

  const prochainMenus = menus.filter((m) => m.date >= today).sort((a, b) => (a.date > b.date ? 1 : -1)).slice(0, 12);

  const envoyerIdee = () => {
    if (!idee.trim() || !enfant) return;
    setMenuIdees([...menuIdees, { id: uid(), enfantId: selectedId, texte: idee.trim(), date: today }]);
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
          <button onClick={() => setModeParent(false)} className="text-xs px-2.5 py-1.5 rounded-md font-semibold border" style={{ borderColor: LINE, color: INK_SOFT }}>Reverrouiller</button>
        ) : (
          <div className="flex items-center gap-1.5">
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

      <Card>
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
      </Card>

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
              <p className="text-2xl font-serif font-bold flex items-center gap-2 mb-2" style={{ color: accent.deep }}><Star size={22} />{enfant.bonPoints}</p>
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
                <Field label="Objectif">
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
            <div className="flex flex-col gap-1.5 mb-3">
              {tachesEnfant.map((t) => {
                const enRetard = t.rappelDate && t.rappelDate <= today && t.statut !== "valide";
                return (
                  <div key={t.id} className="flex items-center justify-between px-2 py-2 rounded-md text-sm flex-wrap gap-y-1"
                    style={{ background: t.statut === "valide" ? accent.soft : t.statut === "en_attente" ? "#FCEFD9" : "transparent" }}>
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <span className="flex items-center justify-center rounded-full text-xl w-10 h-10 shrink-0" style={{ background: "#fff" }}>
                        {emojiTache(t.titre)}
                      </span>
                      {t.statut === "valide" ? (
                        <CheckCircle2 size={18} style={{ color: accent.deep }} />
                      ) : (
                        <input type="checkbox" checked={t.statut === "en_attente"} onChange={() => marquerFait(t)} className="w-5 h-5" />
                      )}
                      <span>
                        <span className="block font-medium" style={{ textDecoration: t.statut === "valide" ? "line-through" : "none", color: t.statut === "valide" ? accent.deep : INK }}>{t.titre}</span>
                        <span className="text-xs flex items-center gap-1.5 flex-wrap" style={{ color: INK_SOFT }}>
                          <Star size={12} />{t.points} pts
                          {t.statut === "en_attente" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F0C36B", color: "#5C4300" }}>en attente de validation</span>
                          )}
                          {enRetard && t.statut === "a_faire" && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "#F3D6D6", color: "#A33B3B" }}>à faire aujourd'hui</span>}
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
                  <Field label="Tâche personnalisée">
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
    setPlanning([...planning, { id: uid(), ...form }]);
    setForm({ titre: "", date: todayISO(), heure: "09:00", pourEnfant: false, description: "" });
  };
  const removeEvent = (id) => setPlanning(planning.filter((p) => p.id !== id));

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
  const toggle = (id) => setTodos(todos.map((t) => (t.id === id ? { ...t, fait: !t.fait } : t)));
  const remove = (id) => setTodos(todos.filter((t) => t.id !== id));

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
