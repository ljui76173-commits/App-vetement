# Mettre l'app en ligne — gratuitement

But : obtenir un **lien https** que toi et la famille pouvez ouvrir depuis
n'importe quel téléphone, avec tes dépenses **conservées pour toujours**.

On utilise **Fly.io** : offre gratuite, et surtout un petit disque qui **garde
tes données** même quand on met l'app à jour. Il faut un ordinateur avec un
terminal pour les 10 minutes d'installation (une seule fois).

> Pas à l'aise avec le terminal ? Dis-le moi, je te guide commande par commande.

---

## Étapes (une seule fois)

**1. Créer un compte Fly.io gratuit**
👉 https://fly.io/app/sign-up
(une carte peut être demandée pour vérifier que tu n'es pas un robot — l'offre
gratuite ne débite rien).

**2. Installer l'outil Fly (`flyctl`)**
- macOS : `brew install flyctl` *(ou `curl -L https://fly.io/install.sh | sh`)*
- Windows (PowerShell) : `iwr https://fly.io/install.ps1 -useb | iex`
- Linux : `curl -L https://fly.io/install.sh | sh`

**3. Se connecter**
```bash
fly auth login
```

**4. Récupérer le code**
```bash
git clone https://github.com/ljui76173-commits/App-vetement.git
cd App-vetement
```

**5. Préparer l'app** (crée l'app et le disque persistant)
```bash
fly launch --no-deploy --copy-config --name TON-NOM-DAPP --region cdg
fly volumes create carnet_data --region cdg --size 1 --yes
```
*(`cdg` = Paris. Choisis un nom d'app unique, ex : `comptes-dupont`.)*

**6. Choisir TON mot de passe éditrice** (pour la saisie)
```bash
fly secrets set EDITOR_TOKEN=choisis-un-mot-de-passe
```

**7. Mettre en ligne**
```bash
fly deploy
```

**8. Ouvrir**
```bash
fly open
```
Tu obtiens une adresse du type `https://ton-nom-dapp.fly.dev`.

---

## Partager à la famille

- **Toi** (saisie) : `https://ton-nom-dapp.fly.dev/`
  → dans ⚙️ Réglages, entre le mot de passe choisi à l'étape 6.
- **La famille** (lecture seule) : `https://ton-nom-dapp.fly.dev/view.html`
- **Le récap** : `https://ton-nom-dapp.fly.dev/recap`

## Mettre à jour plus tard
```bash
git pull
fly deploy
```
Tes dépenses sont conservées (disque persistant).

---

## Option « juste pour essayer » (plus simple, mais efface les données)

Si tu veux seulement tester vite fait sans rien installer, un hébergeur comme
Render (connexion GitHub → déploiement en clics) marche aussi — **mais les
données sont remises à zéro à chaque mise à jour**. À réserver à l'essai, pas au
vrai usage quotidien.
