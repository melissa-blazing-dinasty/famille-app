# Carnet de famille — appli installable

## Ce que contient ce projet

Une appli web (React + Vite) installable sur téléphone comme une vraie appli
(PWA), avec :
- Budget (comptes, transactions, import CSV, base mensuelle)
- Épargne (objectifs thématiques)
- Menus (Midi/Goûter/Soir sur plusieurs semaines) + historique
- Recettes (avec lien TikTok/Insta + texte collé)
- Enfants (argent de poche, bons points, jauge, tâches, récompenses)
- Planning familial partagé (avec lien "Ajouter à Google Agenda")
- To-do solo ou partagée
- Données synchronisées en temps réel entre tous les appareils de la famille
- Notifications locales (voir limites plus bas)

---

## Étape 1 — Créer le projet Firebase (gratuit)

1. Va sur https://console.firebase.google.com
2. "Ajouter un projet" → donne-lui un nom (ex. `carnet-famille`) → crée-le.
3. Dans le menu de gauche : **Build > Firestore Database** → "Créer une base
   de données" → mode **production** → choisis une région proche (`eur3`
   pour l'Europe par exemple).
4. Toujours dans le menu : **Build > Authentication** → onglet
   "Sign-in method" → active **Anonyme** (Anonymous).
5. Clique sur l'icône ⚙️ (Paramètres du projet) > fais défiler jusqu'à
   "Vos applications" > clique sur l'icône `</>` (Web) > donne un nom à
   l'appli > "Enregistrer l'application".
6. Firebase t'affiche un bloc `firebaseConfig = {...}` : copie ces valeurs.

## Étape 2 — Brancher tes clés

Ouvre `src/firebase.js` et remplace les valeurs `"REMPLACE_MOI"` par celles
copiées à l'étape précédente.

## Étape 3 — Publier les règles de sécurité Firestore

Dans la console Firebase : **Firestore Database > Règles**, colle le
contenu du fichier `firestore.rules` fourni ici, puis "Publier".

## Étape 4 — Tester en local

```bash
npm install
npm run dev
```

Ouvre l'adresse affichée (`http://localhost:5173`), choisis un code famille,
et teste. Si tu ouvres le même code dans un autre onglet, les modifications
doivent apparaître dans les deux en temps réel.

## Étape 5 — Déployer (Vercel, gratuit)

```bash
npm install -g vercel
vercel login
vercel
```

Réponds aux questions (dossier courant, pas de framework particulier à
préciser, Vercel détecte Vite automatiquement). À la fin, Vercel te donne
une URL publique (`https://....vercel.app`).

Pour les mises à jour suivantes : `vercel --prod`.

## Étape 6 — Installer sur le téléphone

- **Android (Chrome)** : ouvre l'URL, menu ⋮ > "Ajouter à l'écran d'accueil" /
  "Installer l'application".
- **iPhone (Safari)** : ouvre l'URL, bouton Partager (carré avec flèche) >
  "Sur l'écran d'accueil".

L'appli s'ouvre alors en plein écran avec sa propre icône, comme une appli
native.

---

## Notifications — ce qui marche et ce qui ne marche pas encore

Ce projet demande la permission de notifications et affiche une
**notification locale** (via l'API `Notification` du navigateur) quand
l'appli est ouverte et qu'une tâche ou un évènement du jour est détecté.
Ça fonctionne réellement sur le téléphone, contrairement à la version dans
Claude.

Ce que ça **ne fait pas encore** : prévenir alors que l'appli est
complètement fermée depuis plusieurs heures. Pour ça, il faut activer
**Firebase Cloud Messaging (push serveur)**, ce qui demande :
1. Passer le projet Firebase au plan **Blaze** (pay-as-you-go — reste
   gratuit dans les faits pour un usage familial, mais nécessite une carte
   bancaire enregistrée).
2. Déployer une **Cloud Function** planifiée (ex. tous les matins à 8h) qui
   vérifie les tâches/évènements du jour et envoie les notifications push.

Dis-moi quand tu veux passer à cette étape, on la fera ensemble.

## Sécurité — à savoir

Les données de ta famille sont accessibles à qui connaît ton "code famille"
(pas de mot de passe individuel). Choisis un code long, original, que tu ne
partages qu'en famille. Une vraie authentification par compte (email/mot de
passe par personne) est possible plus tard si tu veux renforcer ça.
