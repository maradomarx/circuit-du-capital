/* =====================================================================
   src/app.js  —  M1 : charte chromatique & chaîne de post-production.

   M0 (portage Vite, r128 → r168 ESM) reste sous-jacent : THREE = core +
   addons de post-processing, compensation BRDF moderne via LIGHT_GAIN,
   CanvasTexture taguées sRGB. Voir l'historique du fichier pour le détail.

   M1 — « La Veille du Capital » : heure bleue industrielle, ombres bleu-
   encre froides, hautes lumières ambre chaudes. La lumière représente le
   capital. Trois ajouts strictement non destructifs :
     1. COLORSCRIPT (source unique de vérité pour les couleurs de monde 3D :
        ciel, brume, soleil, gaz/forge/or, palette héro des zones) — pose le
        socle chromatique sans toucher aux builders, textures ou HUD.
     2. Chaîne de post-prod : composer + UnrealBloomPass recalibré
        (0.55 / 0.4 / 0.82) + GradePass final (split-tone + vignette + grain
        animé). IBL relevé à ~0.7 (hemi compensé) pour faire respirer le HDRI.
     3. Sélecteur qualité Basse/Moyenne/Haute (panneau réglages) appliqué à
        chaud + #qa enrichi (fps lissé · calls · triangles). Repli gracieux
        si EffectComposer absent : bypass propre, zéro erreur console.

   Les missions M2+ découperont ce fichier le long de la frontière déjà
   annoncée dans l'en-tête v66 (World / Vehicle / CameraController / Input
   / HUD / sim).
   ===================================================================== */

import * as THREE_BASE from 'three';
import { EffectComposer }    from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }        from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }   from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }        from 'three/addons/postprocessing/ShaderPass.js';
import { BokehPass }         from 'three/addons/postprocessing/BokehPass.js';
import { CopyShader }        from 'three/addons/shaders/CopyShader.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Miroir THREE = core + addons. Object.assign copie les références ; les
// constructeurs (Mesh, Material…) restent ceux du module three.
const THREE = Object.assign({}, THREE_BASE, {
  EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, BokehPass,
  CopyShader, LuminosityHighPassShader,
});

// Compensation BRDF moderne (cf. en-tête).
const LIGHT_GAIN = Math.PI;
// M8 — LUMINOSITÉ GLOBALE. Un seul curseur traverse TOUTES les sources
// (soleil, lune, hémisphérique, ambiantes, réverbères, forges) parce que
// tout passe par physI. Remonter ici plutôt qu'au cas par cas garde les
// rapports d'intensité de la DA intacts : c'est la scène entière qui monte.
const BRIGHTNESS = 1.42;
const physI = (v) => v * LIGHT_GAIN * BRIGHTNESS;

// CanvasTexture par défaut en sRGB.
(function patchCanvasTextureColorSpace(){
  const Orig = THREE_BASE.CanvasTexture;
  function Patched(...args){
    const t = new Orig(...args);
    t.colorSpace = THREE_BASE.SRGBColorSpace;
    return t;
  }
  Patched.prototype = Orig.prototype;
  Object.setPrototypeOf(Patched, Orig);
  THREE.CanvasTexture = Patched;
})();

// L'AssetManager fournit la texture HDR équirectangulaire ; init() compile
// le PMREM une fois le renderer en place. M1 : ENV_INTENSITY relevé de 0.25
// à 0.7 — le HDRI industriel ambre/bleu devient une vraie source d'ambiance,
// les MeshStandardMaterial respirent la lumière du ciel. hemiLight est
// compensé à la baisse plus bas (0.45 → ajustable) plutôt que de redescendre
// l'IBL si une zone semble trop claire.
// M8 — 0.7 → 0.92 : l'IBL porte davantage l'ambiance, ce qui déboucne les
// faces non exposées au soleil sans avoir à écraser le contraste directionnel.
export const ENV_INTENSITY = 0.92;

/* ===== MOTEUR ÉCONOMIQUE (modules sim, identiques au fichier moteur) ===== */
/* =====================================================================
   SimulationState  —  src/sim/SimulationState.js
   L'état complet. Une seule source de vérité ; la 3D viendra le LIRE.
   ===================================================================== */
class SimulationState {
  constructor(){
    this.cycle = 0;
    this.objectifIndex = 0;      // progression PÉDAGOGIQUE, indépendante du nombre de cycles
    this.cyclesProfitables = 0;  // total de cycles au résultat net positif
    this.objectifCyclesSurPlace = 0;  // cycles consécutifs passés sur le même objectif sans le valider
    this.cyclesSansInvestir = 0;      // cycles sans construire / embaucher / mécaniser / élargir
    this._investedThisCycle = false;  // drapeau interne, remis à zéro chaque tour
    // leviers contrôlés par le joueur
    this.heures = 10;            // journée de travail
    this.salaire = 5;            // £ / ouvrier / cycle
    this.travailleurs = 0;       // L employés — aucun au départ
    this.niveauMachine = 0;      // aucun outillage encore
    // capital monétaire
    this.argent = 400;
    this.dette = 0;
    this._cycleCredit = 0;       // crédit pris pendant le tour (pour le bilan)
    this._cycleRepay = 0;        // dette remboursée pendant le tour
    this._cycleMachine = 0;      // machines achetées à crédit pendant le tour
    this.profitCumule = 0;
    // population / chômage
    this.populationActive = 0;   // pas encore de marché du travail constitué
    // sphère marchande
    this.stocks = 0;             // unités invendues reportées
    this.prixUnitaire = 1.4;     // £/unité (démarre à la valeur)
    this.productionActive = false; // pas de production tant qu'atelier + ouvrier manquent
    this.firstProduced = false;    // 1re marchandise produite ?
    // état social (0..1)
    this.fatigue = 0.1;
    this.sante = 0.9;
    this.colere = 0.1;
    this.peurChomage = 0.2;
    this.conscience = 0.05;
    this.revendication = null;     // revendication ouvrière en cours (journee/salaire/securite/licenciements)
    this.securiteNiveau = 0;       // investissements en sécurité (réduit les accidents)
    this.disciplineBonus = 1;      // surveillance : petit gain de productivité, au prix de la colère
    this._primeActive = 0;         // prime promise : apaise puis, non renouvelée, fâche
    // dérivés du dernier cycle (remplis par les systèmes)
    this.d = {};
    // mémoire pour les deltas affichés
    this.prev = {};
    this.enGreve = false;
    this.fini = false;
    // entreprises concurrentes (IA) — chacune une stratégie d'accumulation
    /* v48 — les concurrents ne sont plus des lignes de tableur : chaque firme est
       incarnée (district sur la carte, ouvriers, machines, stocks, colère, âge propre).
       Les champs prix/productivite/capital/part/vivant restent pilotés par
       CompetitionSystem (parts de marché, faillites) ; CompetitorWorld anime le reste. */
    this.competitors = [
      {nom:'Manufacture Brandt', strat:'mecanise',     prix:1.45, productivite:1.0, capital:320, part:0, vivant:true,
       couleur:0x4a5a6e, district:{x:52,z:32},  workers:7, machineLevel:1, wage:5, stocks:8,  debt:60,  anger:0.15, stage:1,
       enGreve:false, spied:false, devise:'mécanisation agressive : machines, licenciements, prix cassés'},
      {nom:'Filature Verrié',    strat:'bas-salaires', prix:1.36, productivite:1.0, capital:320, part:0, vivant:true,
       couleur:0x7a3a2e, district:{x:86,z:30},  workers:9, machineLevel:1, wage:4, stocks:10, debt:20,  anger:0.30, stage:1,
       enGreve:false, spied:false, devise:'bas salaires : marges rapides, colère ouvrière qui couve'},
      {nom:'Comptoir Halage',    strat:'compromis',    prix:1.55, productivite:1.0, capital:360, part:0, vivant:true,
       couleur:0x5a6a4a, district:{x:-60,z:30}, workers:6, machineLevel:1, wage:6, stocks:5,  debt:0,   anger:0.10, stage:1,
       enGreve:false, spied:false, devise:'prudence : dette faible, croissance lente, stabilité'},
    ];
    this.marketConcentration = 0;   // v48 : indice de concentration (faillites -> oligopole -> quasi-monopole)
    this.rachatDispo = null;   // concurrent en faillite rachetable ce cycle
    // crédit & État
    this.tauxInteret = 0.08;   // recalculé chaque cycle (prime de risque)
    this.plafondCredit = 600;
    this.limiteJournee = 18;   // loi sur la journée de travail (18 = aucune)
    this.modeEtat = 'laisser-faire';
    this.taxe = 0;             // impôt prélevé sur le profit réalisé
    // --- couche "ville capitaliste" (évolution visuelle + modificateurs) ---
    // Avant la production capitaliste : seulement un marché local et des terres communes.
    this.buildings = { banque:0, atelier:0, usine:0, entrepot:0, marche:1, quartier:0, travail:0, rails:0, port:0, bourse:0, terres:1, outils:0 };
    this.demandeBonus = 0;       // marché / port -> + demande solvable
    this.stockCapaciteBonus = 0; // entrepôt -> seuil de stock avant crise relevé
    this.railsBonus = 0;         // rails -> + ventes réalisables
    this.creditBonus = 0;        // banque -> + plafond de crédit
    this.reproSocial = 0;        // logements ouvriers -> apaise la colère
    this.bourseActive = false;   // bourse -> + risque spéculatif
    this.portOuvert = false;     // port -> marché mondial ouvert
    this.niveauVille = 0;        // développement du capital (0..7) — 0 = argent dormant
  }
  get chomage(){
    return this.populationActive>0 ? Math.max(0, this.populationActive - this.travailleurs) / this.populationActive : 0;
  }
}

/* =====================================================================
   ProductionSystem  —  src/sim/ProductionSystem.js
   Le procès P. Seul le travail vivant crée de la valeur nouvelle ;
   les machines démultiplient les unités (use-values) sans créer de valeur.
   ===================================================================== */
const TAU = 1.0;            // valeur nouvelle créée par heure-ouvrier (£)
const PROD_PHYS_BASE = 1.0; // unités par heure-ouvrier, machine niveau 1
const MAT_PAR_UNITE = 0.30; // matières premières par unité (£)
let DEBUG_ECON = false;     // passe à true en console pour tracer la comptabilité de fin de cycle

class ProductionSystem {
  static run(s){
    // Pas de production capitaliste sans atelier ET sans force de travail.
    if(!s.buildings || s.buildings.atelier===0 || s.buildings.outils===0 || s.travailleurs===0){
      Object.assign(s.d, {
        productivitePhys:0, heuresEff:0, valeurNouvelle:0, v:0, plusValue:0, Q:0,
        matieres:0, usure:0, c:0, valeurMarch:0, valeurUnitaire:0,
        travailNecessaire:0, surtravail:0, tauxExploitation:0, tauxProfit:0, compoOrganique:0,
        pasDeProduction:true
      });
      return;
    }
    const divisionBonus = s.niveauVille >= 2 ? 1.15 : 1;   // manufacture : productivité par division du travail
    const productivitePhys = PROD_PHYS_BASE * divisionBonus * (s.disciplineBonus||1) * (1 + 0.5*(s.niveauMachine-1)); // +50%/niveau machine
    const heuresEff = s.heures * (1 - 0.55*s.fatigue) * (s.enGreve ? 0.15 : 1); // fatigue & grève rognent
    const heuresOuvrier = s.travailleurs * heuresEff;

    const valeurNouvelle = heuresOuvrier * TAU;        // v + s
    const v  = s.travailleurs * s.salaire;             // capital variable
    const plusValue = Math.max(0, valeurNouvelle - v); // s
    const Q = Math.round(heuresOuvrier * productivitePhys); // unités physiques

    const matieres = Q * MAT_PAR_UNITE;
    // outils simples (stade atelier) : usure faible ; machines industrielles : usure forte
    const usure = (s.niveauVille<=1) ? Math.min(2, s.niveauMachine) : s.niveauMachine * 10;
    const c = matieres + usure;                        // capital constant consommé

    const valeurMarch = c + valeurNouvelle;            // W = c + v + s
    const valeurUnitaire = Q>0 ? valeurMarch/Q : 0;

    Object.assign(s.d, {
      productivitePhys, heuresEff, valeurNouvelle, v, plusValue, Q,
      matieres, usure, c, valeurMarch, valeurUnitaire,
      travailNecessaire: valeurNouvelle>0 ? v/TAU : 0,
      surtravail: plusValue/TAU,
      tauxExploitation: v>0 ? plusValue/v : 0,
      tauxProfit: (c+v)>0 ? plusValue/(c+v) : 0,
      compoOrganique: v>0 ? c/v : 0,
    });
    if(Q>0) s.firstProduced=true;
  }
}

/* =====================================================================
   CompetitionSystem  —  src/sim/CompetitionSystem.js
   Les autres capitaux. Ils accumulent en silence et tirent les prix vers
   le bas. La demande solvable TOTALE est ici ; le marché la répartit
   selon les prix. Ne pas suivre la course, c'est perdre sa part — donc
   ses débouchés, donc son capital. La concurrence transforme
   l'accumulation en contrainte de survie.
   ===================================================================== */
const DEMANDE_TOTALE_BASE = 465;
const ELASTICITE = 3.2;        // sensibilité des parts au prix

class CompetitionSystem {
  static run(s){
    // 1) demande solvable de TOUTE l'économie
    const consoOuvriere   = s.d.v * 1.15;  // v47 : salaires ↑ -> demande ↑ plus lisible (stratégie salariale viable)
    const consoChomeurs   = Math.max(0, s.populationActive - s.travailleurs) * 0.6;
    const consoCapitaliste= 0.18 * Math.max(0, s.profitCumule);
    const demande = DEMANDE_TOTALE_BASE + (s.demandeBonus||0) + consoOuvriere + consoChomeurs + consoCapitaliste;
    s.d.demande = demande;

    // 2) les concurrents accumulent — pression permanente sur les prix (pas au cycle 1)
    const stagne = (s.niveauVille>=2 && s.cyclesSansInvestir>=2);   // le joueur n'investit plus
    if (s.cycle>2) for(const c of s.competitors){
      if(!c.vivant) continue;
      const boost = stagne ? 1.018 : 1;                            // ils prennent un peu d'avance
      if(c.strat==='mecanise'){      c.productivite*=1.045*boost; c.prix=Math.max(0.70, c.prix*0.955); }
      else if(c.strat==='bas-salaires'){ c.prix=Math.max(0.80, c.prix*0.985); c.productivite*=boost; }
      else {                         c.productivite*=1.008*boost; } // compromis : tient son prix
    }

    // 3) parts de marché ∝ (1/prix)^élasticité — le moins cher rafle le marché
    const firms = [{prix:s.prixUnitaire}, ...s.competitors.filter(c=>c.vivant)];
    const w = firms.map(f=>Math.pow(1/Math.max(0.3,f.prix), ELASTICITE));
    const sum = w.reduce((a,b)=>a+b,0) || 1;
    let i=0;
    s.d.partJoueur = w[i++]/sum;
    for(const c of s.competitors){ c.part = c.vivant ? w[i++]/sum : 0; }

    // 4) santé financière des concurrents -> faillites -> concentration (pas au cycle 1)
    const marketMin = Math.min(...firms.map(f=>f.prix));
    const failed = [];
    if (s.cycle>2) for(const c of s.competitors){
      if(!c.vivant) continue;
      const recette = c.part * demande;
      const tropCher = c.prix > marketMin*1.18 ? (c.prix/marketMin - 1)*45 : 0;
      const marge = recette*0.22 - 6 - tropCher;
      c.capital += marge;
      if(c.capital <= 0){ c.vivant=false; c.part=0; failed.push(c); }
    }
    s.d.faillitesConc = failed;
    if(failed.length && s.argent > 200) s.rachatDispo = failed[failed.length-1];
  }
}

/* =====================================================================
   MarketSystem  —  src/sim/MarketSystem.js
   M′ → A′. La valeur n'est rien tant qu'elle n'est pas RÉALISÉE.
   Le joueur ne vend que sur SA part de la demande totale (cf. concurrence).
   ===================================================================== */
class MarketSystem {
  static run(s){
    const offreUnites = s.stocks + s.d.Q;
    const demandeJoueur = (s.d.demande||0) * (s.d.partJoueur ?? 1); // £ qui me reviennent

    const uVendablesParPrix = s.prixUnitaire>0 ? demandeJoueur / s.prixUnitaire : 0;
    const unitesVendues = Math.min(offreUnites, uVendablesParPrix*(1+(s.railsBonus||0)));
    const recette = unitesVendues * s.prixUnitaire;
    const invendus = offreUnites - unitesVendues;

    const coutsAvances = s.d.c + s.d.v;
    const profitRealise = recette - coutsAvances;

    // ajustement de prix pour le PROCHAIN cycle (réaction à la mévente)
    const tension = offreUnites>0 ? unitesVendues/offreUnites : 1;
    let nouveauPrix = s.prixUnitaire;
    if (tension < 0.95) nouveauPrix *= (1 - 0.10*(1-tension));   // surproduction -> baisse
    else if (offreUnites < uVendablesParPrix) nouveauPrix *= 1.03;
    nouveauPrix = Math.max(0.4, Math.min(2.2, nouveauPrix));

    Object.assign(s.d, {
      demandeJoueur, offreUnites, unitesVendues, invendus, recette, coutsAvances,
      profitRealise, tauxVente: tension, nouveauPrix
    });
  }
}

/* =====================================================================
   LaborSystem  —  src/sim/LaborSystem.js
   Fatigue, santé, colère, peur, conscience. La force de travail s'use.
   ===================================================================== */
// rapport de force entre travail et capital (0 = capital domine, 1 = travail organisé)
function rapportDeForceSocial(s){
  return clamp(0.35*(s.colere||0) + 0.30*(s.conscience||0) + 0.20*(s.fatigue||0)
             - 0.25*(s.peurChomage||0) - 0.15*(s.chomage||0));
}
const REVENDICATIONS = {
  journee:'journée plus courte', salaire:'salaire plus élevé',
  securite:'meilleures conditions de sécurité', licenciements:'refus des licenciements'
};
function maybeCreateRevendication(s){
  if(s.revendication) return;
  if(rapportDeForceSocial(s) < 0.55) return;
  if(s.heures>10) s.revendication='journee';
  else if(s.salaire<5) s.revendication='salaire';
  else if(s.fatigue>0.6) s.revendication='securite';
  else if(s.chomage>0.25) s.revendication='licenciements';
  else s.revendication='salaire';
}
class LaborSystem {
  static run(s){
    const surcharge = Math.max(0, (s.heures - 9) / 8);          // au-delà de 9 h
    const salaireReel = s.salaire / 5;                           // 5 = subsistance de base
    const ch = s.chomage;

    s.fatigue = clamp(s.fatigue + surcharge*0.28 - 0.12);        // récupère un peu sinon
    s.sante   = clamp(s.sante  - (s.fatigue>0.6 ? 0.10 : 0.0) - surcharge*0.04 + 0.02);
    s.peurChomage = clamp(0.15 + ch*1.4);
    // colère : montée si surcharge ou salaire bas ; freinée par la peur du chômage
    const pousseColere = surcharge*0.18 + Math.max(0,(1-salaireReel))*0.25 + (s.fatigue>0.7?0.1:0);
    s.colere = clamp(s.colere + pousseColere - 0.06 - s.peurChomage*0.05 - (s.reproSocial||0));
    // conscience collective : la colère partagée s'organise
    s.conscience = clamp(s.conscience + (s.colere>0.6 ? 0.08 : -0.02));

    // armée industrielle de réserve : double fonction du chômage
    if (s.chomage>0.25){
      s.peurChomage = clamp(s.peurChomage + 0.08);   // discipline : peur du chômage
      s.colere = clamp(s.colere - 0.03);             // colère contenue à court terme
      s.d.demandeOuvriereFragilisee = true;          // mais la demande solvable faiblit
    }
    if (s.chomage>0.35 && s.cycle>6){
      s.conscience = clamp(s.conscience + 0.03);     // misère prolongée : colère différée s'organise
    }

    // rapport de force et grève — rare et tardive (après la manufacture)
    const rapport = rapportDeForceSocial(s);
    s.d.rapportSocial = rapport;
    maybeCreateRevendication(s);
    s.enGreve = (rapport>0.62 && s.colere>0.65 && s.conscience>0.40 && s.peurChomage<0.65);
    if (s.cycle<=5 || s.niveauVille<2) s.enGreve = false;   // pas de grève avant la manufacture

    // accidents
    s.d.accident = (s.fatigue>0.75 && Math.random()<0.4) || (s.heures>13 && Math.random()<0.3);
    if (s.securiteNiveau>0 && s.d.accident && Math.random()<0.55) s.d.accident=false;  // sécurité réduit le risque
  }
}

/* =====================================================================
   CrisisSystem  —  src/sim/CrisisSystem.js
   Le risque n'est pas un script : c'est une somme pondérée des tensions.
   ===================================================================== */
const STOCK_SEUIL = 220, DETTE_SEUIL = 900;
class CrisisSystem {
  static run(s){
    const stockN = Math.min(1, s.stocks / (STOCK_SEUIL + (s.stockCapaciteBonus||0)));
    const detteN = Math.min(1, s.dette / DETTE_SEUIL);
    const venteN = 1 - (s.d.tauxVente ?? 1);
    const surinvest = Math.min(1, Math.max(0, s.d.compoOrganique-3)/5);
    const crunchN = s.d.creditCrunch ? 0.2 : 0;
    const age = s.age||0;
    const speculN = s.bourseActive ? (age>=5?0.16:0.08) : 0;   // capital fictif -> prime de risque (renforcée en finance)
    const dividN = Math.min(0.12, (s.dividende||0)/400);        // dividendes à servir = fragilité financière
    const ageRisk = age>=5 ? 0.18 : age>=4 ? 0.13 : age>=3 ? 0.10 : 0;   // les contradictions montent avec l'échelle
    const risque = clamp(0.42*stockN + 0.24*detteN + 0.22*s.chomage + 0.30*venteN + 0.12*surinvest + crunchN + speculN + dividN + ageRisk);
    s.d.risqueCrise = risque;
    s._risqueChaud = (s._risqueChaud||0);
    s.d.declenche = false;
    const seuil = age>=3 ? 0.58 : 0.66;                        // grande échelle : le seuil de crise s'abaisse
    const besoinChaud = age>=4 ? 1 : 2;                        // ville/finance/monde : la crise éclate plus vite
    if (risque > seuil){ s._risqueChaud++; } else { s._risqueChaud = Math.max(0, s._risqueChaud-1); }
    if (s._risqueChaud >= besoinChaud && s.cycle>2){           // tension soutenue -> crise (jamais au cycle 1)
      s.d.declenche = true; s._risqueChaud = 0;
      s.d.nouveauPrix *= 0.6;            // krach des prix (sur le tour suivant)
      const liquides = Math.round(s.stocks*0.7);
      s.stocks -= liquides;              // bradés
      const licencies = Math.max(0, Math.round(s.travailleurs*0.35));
      s.travailleurs -= licencies;       // dégraissage
      s.colere = clamp(s.colere+0.2);
      s.d.licenciesCrise = licencies;
    }
  }
}

/* =====================================================================
   CreditSystem  —  src/sim/CreditSystem.js
   La banque finance l'accumulation, mais à un taux qui monte avec le
   levier (prime de risque). Surendetté et peu rentable, on subit le
   "credit crunch" : le robinet se ferme exactement quand il faudrait
   qu'il coule. Le crédit accélère la course — et la chute.
   ===================================================================== */
class CreditSystem {
  static run(s){
    const collateral = Math.max(0, s.argent) + s.niveauMachine*150;
    s.plafondCredit = Math.round(collateral*1.2 + 200 + (s.creditBonus||0));
    const leverage = s.dette / Math.max(1, collateral);
    // taux lisible : faible au début, prime de risque seulement si la dette devient lourde
    if (s.cycle <= 3){
      s.tauxInteret = 0.01;                                  // premiers cycles : crédit doux
    } else {
      const base = 0.02;
      const primeRisque = 0.04 * Math.min(1, leverage) + (leverage>1.5 ? 0.06*(leverage-1.5) : 0);
      s.tauxInteret = +(base + primeRisque).toFixed(3);
    }
    s.d.leverage = leverage;
    // rappel de crédit : surendettement + profit négatif (jamais dans les 3 premiers cycles)
    s.d.creditCrunch = (s.cycle>3 && leverage > 1.5 && (s.d.profitRealise||0) < 0);
    if (s.d.creditCrunch){
      const rappel = Math.round(s.dette*0.15);
      s.argent -= rappel;       // remboursement forcé
      s.dette  -= rappel;
      s.d.crunchAmount = rappel;
    }
  }
}

/* =====================================================================
   StateSystem  —  src/sim/StateSystem.js
   L'État n'est pas au-dessus de la mêlée : il garantit l'accumulation,
   mais doit aussi préserver la paix sociale et la reproduction de la
   force de travail. Selon le rapport de force (lutte des classes), il
   légifère sur la journée, réprime, concède, ou sauve le système.
   ===================================================================== */
class StateSystem {
  static run(s){
    if (s.cycle<=2){ s.d.pressionPop=0; return; }   // cycles 1-2 : l état n entre pas encore en scène
    const pressionPop = s.colere*0.40 + s.conscience*0.30 + s.chomage*0.30 + (s.d.accident?0.15:0);
    s.d.pressionPop = pressionPop;

    // 1) loi sur la journée de travail (Factory Acts)
    if ((s.d.accident || s.heures>=13) && pressionPop>0.40 && s.limiteJournee>10){
      s.limiteJournee = 12;
      s.heures = Math.min(s.heures, s.limiteJournee);
      s.d.loiJournee = s.limiteJournee;
    }
    if (pressionPop>0.70 && s.limiteJournee>8){
      s.limiteJournee = 8; s.heures = Math.min(s.heures, 8); s.d.loiJournee = 8;
    }

    // 2) les grèves ne sont plus arbitrées automatiquement : le joueur décide (modale Conflit social).
    //    L'État garde son rôle sur la journée de travail et le sauvetage de crise.
    if (!s.enGreve && pressionPop<0.30){ s.modeEtat='laisser-faire'; }

    // 3) sauvetage du système en cas de crise
    if (s.d.declenche){
      s.modeEtat='réforme';
      s.d.nouveauPrix *= 1.25;   // soutien de la demande, amortit le krach
      s.taxe = 0.05;             // financé par l'impôt — qui pèsera ensuite
      s.d.sauvetage=true;
    }
  }
}

/* =====================================================================
   CapitalCircuit  —  src/sim/CapitalCircuit.js
   Orchestre un tour complet A → M → P → M′ → A′ et règle la trésorerie.
   ===================================================================== */
class CapitalCircuit {
  constructor(state){ this.s = state; }
  cycle(){
    const s = this.s;
    s.prev = { argent:s.argent, stocks:s.stocks, tauxExploitation:s.d.tauxExploitation||0,
               tauxProfit:s.d.tauxProfit||0, profitRealise:s.d.profitRealise||0, plusValue:s.d.plusValue||0,
               colere:s.colere, fatigue:s.fatigue, chomage:s.chomage,
               risqueCrise:s.d.risqueCrise||0, prixUnitaire:s.prixUnitaire, partJoueur:s.d.partJoueur };
    s.cycle++;
    s.d = {};
    s.rachatDispo = null;

    // P : production de la valeur
    ProductionSystem.run(s);
    // les autres capitaux : demande totale + parts de marché
    CompetitionSystem.run(s);
    // M′ → A′ : réalisation sur MA part du marché
    MarketSystem.run(s);
    // social
    LaborSystem.run(s);
    // crédit : taux, plafond, rappel éventuel
    CreditSystem.run(s);
    // tensions systémiques
    CrisisSystem.run(s);
    // l'État réagit (loi, répression, concession, sauvetage)
    StateSystem.run(s);

    // règlement monétaire : recettes, coûts, intérêts (taux dynamique), impôt
    const interets = (s.dette>0) ? Math.round(s.dette * s.tauxInteret) : 0;  // pas d'intérêt sans dette
    const impot = Math.round(Math.max(0, s.d.profitRealise) * s.taxe);
    s.argent += s.d.recette - s.d.coutsAvances - interets - impot;
    s.profitCumule += s.d.profitRealise - interets - impot;
    s.stocks = Math.max(0, s.d.invendus);   // stock final = invendus restants (déjà = ancien stock + Q − ventes)
    s.prixUnitaire = s.d.nouveauPrix;     // prix pour le tour suivant (crash/sauvetage inclus)
    s.d.interets = interets; s.d.impot = impot;
    // résultat productif (atelier) vs résultat net (après dette/impôt)
    s.d.resultatProductif = s.d.profitRealise;                 // recette − salaires − matières − usure
    s.d.resultatNet = s.d.profitRealise - interets - impot;
    if(s.d.resultatNet > 0) s.cyclesProfitables++;             // total de cycles bénéficiaires (net)
    // dette : photo du tour pour le bilan
    const credit=s._cycleCredit||0, repay=s._cycleRepay||0;
    s.d.detteFin = s.dette;
    s.d.detteDebut = Math.max(0, s.dette - credit + repay);    // avant les mouvements du tour
    s.d.creditPris = credit; s.d.detteRemb = repay; s.d.taux = s.tauxInteret;
    s.d.machineAchat = s._cycleMachine||0;
    s._cycleCredit = 0; s._cycleRepay = 0; s._cycleMachine = 0;       // remise à zéro pour le tour suivant
    // accumulation : ai-je investi ce tour-ci ?
    if(s._investedThisCycle) s.cyclesSansInvestir = 0; else s.cyclesSansInvestir++;
    s._investedThisCycle = false;
    s.d.stagne = (s.niveauVille>=2 && s.cyclesSansInvestir>=2);       // « accumuler ou être dépassé »
    if(s._primeActive>0){ s._primeActive--; if(s._primeActive===0) s.colere=clamp(s.colere+0.08); } // prime non renouvelée
    if (typeof DEBUG_ECON!=='undefined' && DEBUG_ECON){
      console.table({ cycle:s.cycle, argentAvant:s.prev.argent, recette:s.d.recette, couts:s.d.coutsAvances,
        interets, impot, profitRealise:s.d.profitRealise, argentApres:s.argent, production:s.d.Q,
        vendues:s.d.unitesVendues, ancienStock:s.prev.stocks, invendusFinaux:s.d.invendus, stockFinal:s.stocks });
    }

    // faillite
    if (s.argent < -200){ s.d.faillite = true; s.fini = true; }
    return s.d;
  }
}

/* =====================================================================
   EventLog  —  src/sim/EventLog.js
   Transforme le tableur en chronique. C'est lui qui donne l'effet
   "Dwarf Fortress" : on lit l'histoire au lieu de regarder des nombres.
   ===================================================================== */
class EventLog {
  constructor(){ this.entries = []; }
  pousser(texte, type='plain'){ this.entries.unshift({an:null, texte, type}); }
  chroniquer(s){
    const an = 1800 + s.cycle;
    const out = [];
    const add=(t,type='plain')=>out.push({type, t});

    if (s.d.declenche){
      add(`Crise. Les marchandises ne trouvent plus d’acheteurs : les prix s’effondrent, ${s.d.licenciesCrise} ouvriers sont jetés à la rue, les stocks sont bradés. Ce n’est pas un accident venu du dehors — c’est le circuit lui-même qui se grippe.`, 'crisis');
    }
    if (s.d.faillite){ add(`Faillite. Le capital avancé ne revient plus. L’entreprise s’éteint ; un concurrent rachètera ses machines pour rien — le capital se concentre.`, 'crisis'); }

    if (s.d.tauxExploitation > (s.prev.tauxExploitation||0) + 0.15)
      add(`Le taux d’exploitation grimpe à ${pct(s.d.tauxExploitation)} : l’ouvrier travaille une part croissante de sa journée gratuitement pour le capital.`, 'social');

    if (s.d.profitRealise < s.d.plusValue - 8 && s.d.invendus > 3)
      add(`Paradoxe : on a extrait ${money(s.d.plusValue)} de plus-value, mais seulement ${money(Math.max(0,s.d.profitRealise))} de profit réalisé. ${Math.round(s.d.invendus)} unités restent invendues. Produire ne suffit pas : encore faut-il vendre.`, 'warn');

    if (s.d.invendus > 5)
      add(`${Math.round(s.d.invendus)} unités s’entassent dans les entrepôts (stock total : ${Math.round(s.stocks)}). Les prix fléchissent.`, 'warn');

    if (s.prev.chomage!==undefined && s.chomage > s.prev.chomage + 0.05)
      add(`Le chômage monte à ${pct(s.chomage)}. L’armée industrielle de réserve grossit — et avec elle la pression à la baisse sur les salaires.`, 'social');

    if (s.d.accident)
      add(`Un accident à l’atelier. Au-delà de dix heures, les corps lâchent ; la machine, elle, ne se fatigue pas.`, 'social');

    if (s.enGreve)
      add(`Grève. La colère est devenue collective ; la production s’arrête presque. La force de travail rappelle qu’elle n’est pas une chose.`, 'social');

    (s.d.faillitesConc||[]).forEach(c=>
      add(`${c.nom} fait faillite. Ses machines partiront pour une bouchée de pain : le capital se concentre entre moins de mains.`, 'crisis'));

    if (s.d.partJoueur!==undefined && s.d.partJoueur < 0.17)
      add(`Ta part de marché tombe à ${pct(s.d.partJoueur)}. Les concurrents qui ont mécanisé vendent moins cher ; rester en place, c’est déjà reculer.`, 'warn');

    if (s.d.loiJournee)
      add(`L’État promulgue une loi : la journée de travail est plafonnée à ${s.d.loiJournee} heures. La limite à l’exploitation absolue ne vient pas du marché — elle est arrachée par la loi.`, 'social');
    if (s.d.repression)
      add(`L’État réprime la grève. Le calme revient dans l’atelier — mais la matraque laisse une mémoire, et la conscience de classe s’aiguise.`, 'social');
    if (s.d.concession)
      add(`Le rapport de force a tourné : l’État impose une concession, les salaires montent d’un cran.`, 'social');
    if (s.d.creditCrunch)
      add(`La banque rappelle ${money(s.d.crunchAmount)} de crédit. Le robinet se ferme au pire moment : le crédit qui accélérait l’accumulation précipite la chute.`, 'warn');
    if (s.d.sauvetage)
      add(`L’État vole au secours du système : il soutient les prix et renfloue, financé par l’impôt. Le capital privatise les profits et socialise les crises.`, 'crisis');

    if (out.length===0)
      add(`Le cycle s’est bouclé : ${money(s.d.recette)} encaissés, ${money(Math.max(0,s.d.profitRealise))} de profit. L’argent revient augmenté, puis repart.`);

    out.forEach(e=> this.entries.unshift({an, texte:e.t, type:e.type}));
  }
}

/* ---------- utilitaires ---------- */
function clamp(x){ return Math.max(0, Math.min(1, x)); }
function money(x){ return `${Math.round(x).toLocaleString('fr-FR')} £`; }
function money2(x){ return `${(Math.round(x*100)/100).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})} £`; }
function pct(x){ return `${Math.round(x*100)} %`; }


/* ===== RENDU 3D + LIAISON ===== */
/* ===================================================================
   Palette partagée avec le site / le moteur
   =================================================================== */
/* Palette centrale — « vieux registre comptable qui devient ville industrielle » */
const THEME = {
  paper:0xe9ddc6, ink:0x241f17, red:0x8a2c1d, gold:0xa8812c,
  brown:0x5a4530, darkBrown:0x33261b, iron:0x4b4a45, smoke:0x6c665c,
  worker:0x4d5f70, cloth:0x2f3a44, grassDead:0x9b8d6d, crisis:0x5b1712,
};
const COL = {
  papier:THEME.paper, sol:0xd6c6a2, encre:THEME.ink,
  rouge:THEME.red, or:THEME.gold, bleu:THEME.worker, brun:THEME.brown,
  pierre:0xcabf9f, charbon:THEME.darkBrown, vert:0x4f5a3e, froid:0x6c7d8c,
  fer:THEME.iron, fumee:THEME.smoke, crise:THEME.crisis,
};

/* M1 — « La Veille du Capital ». COLORSCRIPT est désormais la SOURCE
   UNIQUE DE VÉRITÉ pour les couleurs du monde 3D (ciel, brume, soleil,
   sources industrielles, palette héro des zones). THEME/COL restent pour
   les éléments graphiques 2D (HUD, papier) et les builders existants ;
   COLORSCRIPT pilote l'ambiance lumineuse. */
const COLORSCRIPT = {
  skyZenith:   0x1b2433,
  skyHorizon:  0xd98a3d,
  fogColor:    0x46506b,
  sunColor:    0xff9a4d,
  gasLight:    0xffb45e,
  forgeLight:  0xff5a28,
  goldLight:   0xffd98a,
  banque:   { hero:0xc9a44a },
  bourse:   { hero:0xe8c86a },
  etat:     { hero:0x8c93a4 },
  usine:    { hero:0x8a2c1d },
  marche:   { hero:0xb0622f },
  quartier: { hero:0x3d4a5c },
  terres:   { hero:0x6b7a4a },
  mines:    { hero:0x2a2622 },
  port:     { hero:0x35586b },
};

/* ===================================================================
   MiniCircuit  —  STUB. Sera remplacé par le vrai CapitalCircuit.js
   (déjà écrit) au portage. Ici : juste de quoi rendre le HUD vivant
   quand on traverse les zones. Aucune simulation sérieuse.
   =================================================================== */
/* ===== LIAISON moteur <-> monde 3D ===== */
const state   = new SimulationState();
const circuit = new CapitalCircuit(state);
const log     = new EventLog();

let cycleCooldown=0, lastLogLen=log.entries.length, flashTimer=0;

function runCycle(){
  // M-Cinéma — snapshot AVANT le cycle pour mesurer les deltas (zone qui
  //   a le plus changé). La séquence joue APRÈS le cycle si un delta
  //   significatif existe et qu'aucun modal n'est ouvert.
  if(typeof CinemaSequences !== 'undefined') CinemaSequences.snapshotCycle();
  snapshotHUD();            // v47 : photo des valeurs affichées -> les ▲▼ du HUD comparent cycle à cycle
  circuit.cycle();
  log.chroniquer(state);
  const fresh = log.entries.slice(0, log.entries.length-lastLogLen);
  lastLogLen = log.entries.length;
  fresh.reverse().forEach(e=>pushLog('An '+(e.an||''), e.texte, e.type));
  if(state.d.declenche || state.d.faillite) flashTimer=0.45;
  updateHUD(); updateMarx(); renderLeviers();
  if(typeof LivingWorld!=='undefined') LivingWorld.onCycle();
  if(gameMode==='guided' && gamePhase==='circuit' && state.cycle>=1) pendingEnterSF=true;
  // Séquence de bouclage : panoramique sur la zone qui a le plus changé.
  //   Garde-fou : pas de cinéma si une modale est ouverte (lecture confort
  //   prioritaire) et pas avant le cycle 2 (laisse les premières actions
  //   se faire sans interruption).
  if(typeof CinemaSequences !== 'undefined' && state.cycle >= 2
     && !(typeof anyModalOpen==='function' && anyModalOpen())){
    CinemaSequences.playCycle();
  }
  // M9 — le cycle est l'unité de progression du jeu : c'est le point de
  // sauvegarde automatique naturel. Silencieux (pas de ligne de journal) —
  // le joueur n'a pas à être interrompu à chaque tour.
  if(typeof SaveGame!=='undefined') SaveGame.autosave();
}

// MiniCircuit garde son nom (la 3D l'appelle deja) mais PILOTE le vrai moteur.
const MiniCircuit = {
  cargo:'argent',
  reset(){ this.cargo='argent'; },
  get argent(){ return state.argent; },
  get profit(){ return state.d.profitRealise||0; },
  get dette(){ return state.dette; },
  get stocks(){ return Math.round(state.stocks); },
  get chomage(){ return state.chomage; },
  get colere(){ return state.colere; },
  banque(){ this.cargo='argent';
    if(state.cycle<=2)
      return ["Banque","Cette fois, l’argent que tu avances est du capital : il ne dort plus, il part pour revenir augmenté. Le crédit viendra plus tard."];
    if(state.dette>0)
      return ["Banque",`Crédit ouvert. Dette : ${money(state.dette)} · taux ${pct(state.tauxInteret)}. Emprunte ou rembourse au panneau.`];
    return ["Banque",`Tu peux emprunter pour investir — mais le crédit se rembourse avec intérêts (taux ${pct(state.tauxInteret)}). Choisis au panneau.`]; },
  marcheMP(){ this.cargo='moyens'; return ["March\u00e9 des moyens",`Capital constant. Machines : niveau ${state.niveauMachine}. Ach\u00e8te des machines au panneau pour m\u00e9caniser. (M)`]; },
  marcheTravail(){ this.cargo='moyens'; return ["March\u00e9 du travail",`Capital variable. Ouvriers : ${state.travailleurs}, salaire ${state.salaire} \u00a3. Ch\u00f4mage : ${pct(state.chomage)}.`]; },
  usine(){ this.cargo='marchandises'; const p=productionPlaceLabel(); return ['Usine',`Journée de ${state.heures} h. Stade actuel : ${p.toLowerCase()}. C'est ici qu'on arrache le surtravail — règle la journée au panneau. (P)`]; },
  entrepot(){ return ["Entrep\u00f4t", state.stocks>1?`${Math.round(state.stocks)} marchandises invendues s'accumulent (M\u2032).`:"Peu de stock \u2014 la valeur s'\u00e9coule pour l'instant."]; },
  marcheVente(){ this.cargo='argent';
    return ["March\u00e9 de vente","M\u2032\u2192A\u2032 : c'est ici que la valeur se r\u00e9alise en argent. Boucler le circuit ici termine le cycle."]; },
  quartier(){ return ["Quartier ouvrier",`Ch\u00f4mage ${pct(state.chomage)}, col\u00e8re ${pct(state.colere)}, fatigue ${pct(state.fatigue)}.`+(state.enGreve?" GR\u00c8VE en cours.":"")]; },
  etat(){ return ["\u00c9tat \u00b7 Tribunal", state.limiteJournee<18?`Loi en vigueur : journ\u00e9e plafonn\u00e9e \u00e0 ${state.limiteJournee} h. Posture : ${state.modeEtat}.`:`Aucune loi vot\u00e9e. Posture de l'\u00c9tat : ${state.modeEtat}.`]; },
  terres(){ return ["Terres communes","Accumulation primitive : cl\u00f4turer les communs, expulser les paysans, fabriquer une population disponible pour le salariat."]; },
  mines(){ this.cargo='moyens'; return ["Mines \u00b7 Champs","Charbon, fer, coton, bl\u00e9 : mati\u00e8res premi\u00e8res et rente entrent dans le circuit."]; },
  port(){ return ["Port \u00b7 March\u00e9 mondial","Le circuit d\u00e9borde les fronti\u00e8res : d\u00e9bouch\u00e9s et mati\u00e8res mondiales, d\u00e9pendance coloniale."]; },
  bourse(){ return ["Bourse",`Capital fictif et sp\u00e9culation. Risque de crise syst\u00e9mique : ${pct(state.d.risqueCrise||0)}.`]; },
};const CARGO_COLOR = { argent:COL.or, moyens:COL.brun, marchandises:COL.rouge };

/* ===================================================================
   World / MapBuilder  —  sol, lumière, décor, zones
   =================================================================== */
let scene, renderer, camera;
const zones = [];        // {name, pos, radius, key, mesh, label, action}
const zoneGroups = {};   // name -> THREE.Group (pour les conséquences visibles)
const obstacles = [];    // {pos, radius} pour collisions simples
const HALF = 120;        // v49 : monde élargi mais compact — les quartiers d'entreprise s'insèrent ENTRE les institutions partagées

// M-Peaufinage/D : registre des marqueurs de zone (panneaux £/P/A'/…
//   et grands panneaux nominatifs). Chaque frame, leur opacité est
//   modulée par la distance au chariot — invisibles de très près
//   (pour ne pas masquer la scène), pleins de loin (fonction de repère
//   conservée). L'interaction de zone (handleZones) reste inchangée :
//   on ne touche que material.opacity.
const _zoneSigns = [];
const _M_PEAUFINAGE_signWP = new THREE.Vector3();
function updateZoneSignsFade(){
  if(!_zoneSigns.length) return;
  if(typeof Vehicle==='undefined' || !Vehicle.pos) return;
  const vx = Vehicle.pos.x, vz = Vehicle.pos.z;
  for(let i=0;i<_zoneSigns.length;i++){
    const sp = _zoneSigns[i];
    if(!sp || !sp.parent || !sp.material) continue;
    sp.getWorldPosition(_M_PEAUFINAGE_signWP);
    const dx = _M_PEAUFINAGE_signWP.x - vx, dz = _M_PEAUFINAGE_signWP.z - vz;
    const d = Math.hypot(dx, dz);
    // Courbe : < 6 m → 0.10 (discret) ; 6..18 m → ramp ; > 18 m → 1.0.
    let k;
    if(d < 6) k = 0.10;
    else if(d > 18) k = 1.0;
    else k = 0.10 + 0.90 * ((d - 6) / 12);
    sp.material.opacity = k;
  }
}

function makeLabel(text){
  const c=document.createElement('canvas'); c.width=640; c.height=160;
  const x=c.getContext('2d');
  let fs=50; x.font=`600 ${fs}px "Zilla Slab", serif`;
  while(x.measureText(text).width>560 && fs>22){ fs-=4; x.font=`600 ${fs}px "Zilla Slab", serif`; }
  const w=Math.min(600, x.measureText(text).width+72), h=104, px=(640-w)/2, py=(160-h)/2;
  // ombre portée façon gravure
  x.fillStyle='rgba(36,31,23,0.30)'; roundRect(x,px+7,py+8,w,h,7); x.fill();
  // plaque papier
  x.fillStyle='#e9ddc6'; roundRect(x,px,py,w,h,7); x.fill();
  // double cadre encre
  x.strokeStyle='#241f17'; x.lineWidth=5; roundRect(x,px,py,w,h,7); x.stroke();
  x.strokeStyle='#241f17'; x.lineWidth=1.5; roundRect(x,px+8,py+8,w-16,h-16,4); x.stroke();
  // texte encre
  x.fillStyle='#241f17'; x.textAlign='center'; x.textBaseline='middle';
  x.font=`600 ${fs}px "Zilla Slab", serif`; x.fillText(text,320,82);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=4;
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false}));
  spr.scale.set(12,3,1);
  return spr;
}
function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);
  c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}

function box(w,h,d,color,x,y,z,castShadow=true){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),
    new THREE.MeshStandardMaterial({color,roughness:.9,metalness:.02,flatShading:true}));
  m.position.set(x,y,z); m.castShadow=castShadow; m.receiveShadow=true; return m;
}

function createPaperGroundTexture(){
  /* v66 — fini le papier quadrillé : une TERRE. Base brune-verte irrégulière,
     grandes plaques d'usure, cailloutis, herbe rase par endroits. Le nom de la
     fonction est conservé pour ne toucher aucun appelant. */
  const c=document.createElement('canvas'); c.width=c.height=1024; const x=c.getContext('2d');
  const g=x.createRadialGradient(512,512,120,512,512,760);
  g.addColorStop(0,'#8d8062'); g.addColorStop(0.6,'#83775c'); g.addColorStop(1,'#776b52');
  x.fillStyle=g; x.fillRect(0,0,1024,1024);
  // grandes plaques organiques (terre plus sombre / plus claire / verdâtre)
  for(let i=0;i<70;i++){
    const px=Math.random()*1024, py=Math.random()*1024, r=40+Math.random()*150;
    const tones=['141,128,96','120,108,80','116,118,84','152,140,104'];
    const tone=tones[Math.floor(Math.random()*tones.length)];
    const gr=x.createRadialGradient(px,py,r*0.2,px,py,r);
    gr.addColorStop(0,`rgba(${tone},${0.10+Math.random()*0.14})`); gr.addColorStop(1,`rgba(${tone},0)`);
    x.fillStyle=gr; x.beginPath(); x.arc(px,py,r,0,6.3); x.fill();
  }
  // cailloutis et brins
  for(let i=0;i<900;i++){
    const px=Math.random()*1024, py=Math.random()*1024;
    x.fillStyle=Math.random()<0.5?`rgba(60,52,38,${0.10+Math.random()*0.18})`:`rgba(170,158,120,${0.08+Math.random()*0.14})`;
    x.fillRect(px,py,1+Math.random()*2.4,1+Math.random()*2.4);
  }
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=4; return tex;
}

function buildWorld(){
  scene=new THREE.Scene();
  // M1 — filet de sécurité derrière le dôme : passe à la brume bleu-encre.
  scene.background=new THREE.Color(COLORSCRIPT.fogColor);
  buildSky();                                    // M2 : dôme 3 stops + biais ouest doré
  buildHorizon();                                // M2 : skyline industrielle 2 couches + fumées
  buildSkyAtmosphere();                          // M2 : soleil, voile doré, godrays, nuages
  buildNightLights();                            // v66 : les lumières qui peignent la nuit
  // M2 — fog réchauffé : 0x5a5560 (bleu-mauve plus chaud, accordé à l'inflexion
  // dorée). near/far retunés pour fondre la skyline (210/280) dans le bas du ciel.
  scene.fog=new THREE.Fog(0x5a5560, 90, 260);

  // lumières — M1 : ciel bleu froid / sol terre encre, intensité abaissée
  // pour laisser l'IBL (ENV_INTENSITY=0.7) faire le gros de l'ambiance.
  // r128 → r16x : intensités multipliées par π (cf. en-tête, LIGHT_GAIN).
  // M7 — sol nocturne légèrement réchauffé : groundColor de hemi tiré vers
  // 0x35251a (brun foncé) au lieu de 0x2e2820 — restitue la chaleur résiduelle
  // de la ville/réverbères dans le ciel renvoyé au sol.
  hemiLight=new THREE.HemisphereLight(0x6b7a9c, 0x35251a, physI(0.45)); scene.add(hemiLight);
  scene.add(new THREE.AmbientLight(0xb9a884, physI(.22)));
  // M7 — moonAmbient : floor warm subtil activé UNIQUEMENT la nuit.
  // Réveille les zones non éclairées en les amenant juste au-dessus du noir
  // (0x14110c env. après intégration) sans casser le contraste ni nourrir
  // le bloom (couleur très sombre + intensité basse).
  nightAmbient=new THREE.AmbientLight(0x24180e, 0); scene.add(nightAmbient);
  // M7-soleil — moonLight : seconde directionnelle pour la lune. Couleur
  // bleu-lune (0xb4c4e0), intensité pilotée par SunState.moonIntensity (0
  // le jour, max ~0.32 quand la lune est au zénith). Sans ombre — la lune
  // n'a pas besoin de caster, et ça économise une shadow map.
  moonLight=new THREE.DirectionalLight(0xb4c4e0, 0);
  moonLight.position.set(0,1,0); moonLight.castShadow=false; scene.add(moonLight);
  sunLight=new THREE.DirectionalLight(COLORSCRIPT.sunColor, physI(0.85));
  sunLight.position.set(58,72,42); sunLight.castShadow=true;
  sunLight.shadow.mapSize.set(2048,2048); sunLight.shadow.bias=-0.0004;
  sunLight.shadow.radius=3.5;           // v62 : pénombre douce, façon jouet
  const s=160; const c=sunLight.shadow.camera;
  c.left=-s;c.right=s;c.top=s;c.bottom=-s;c.near=1;c.far=360;
  scene.add(sunLight);

  // sol — carte économique sur papier ancien
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(HALF*2,HALF*2),
    new THREE.MeshStandardMaterial({color:0xb6ab8e, map:createPaperGroundTexture(), roughness:1, metalness:0}));  // v66 : terre
  ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);

  // bordure — v51 : le cadre est désormais un carré aligné à ±HALF (il contenait avant
  // un losange de demi-côté HALF/√2 ≈ 85 : les quartiers d'entreprise flottaient HORS du cadre)
  const edge=new THREE.Mesh(new THREE.RingGeometry((HALF-0.6)*Math.SQRT2,HALF*Math.SQRT2,4,1),
    new THREE.MeshBasicMaterial({color:COL.encre}));
  edge.rotation.x=-Math.PI/2; edge.rotation.z=Math.PI/4; edge.position.y=0.02; scene.add(edge);

  // --- v52 : LA VILLE-RUE — la géographie raconte la direction du jeu ---
  // Grand-rue est-ouest (z = 0). On la descend d'ouest en est : c'est le trajet A -> A'.
  //   FAÇADE NORD (z ≈ -25) : la campagne d'origine puis les institutions du capital ;
  //   2e RANGÉE NORD (z ≈ -60) : ce qui surplombe — Mines, Bourse, État ;
  //   CÔTÉ SUD (z ≈ +30) : les parcelles industrielles ALIGNÉES (Halage · TOI · Brandt · Verrié) ;
  //   2e RANGÉE SUD (z ≈ +62) : le quartier ouvrier, derrière les usines ;
  //   EXTRÉMITÉ EST : le marché de vente puis le Port — la rue débouche sur le monde.
  defineZone('Terres communes',           -105,-30, 0x6f7a45,   '',    buildTerresCommunes);
  defineZone('Banque',                     -72,-25, COL.pierre, 'A',   buildBanque);
  defineZone('Marché des moyens',          -40,-25, COL.brun,   'M',   buildMarcheMP);
  defineZone('Marché du travail',           -8,-25, COL.froid,  'Ft',  buildMarcheTravail);
  defineZone('Marché de vente',             55,-25, COL.vert,   "A'",  buildMarche);
  defineZone('Mines · Champs',            -105,-62, 0x6b5a3f,   '',    buildMines);
  defineZone('Bourse',                     -72,-60, COL.or,     '',    buildBourse);
  defineZone('État · Tribunal',             -8,-60, COL.vert,   '',    buildEtat);
  defineZone('Usine',                      -15, 30, COL.charbon,'P',   buildUsine);
  defineZone('Entrepôt',                    18, 32, COL.brun,   'M′',  buildEntrepot);
  defineZone('Quartier ouvrier',             0, 62, COL.froid,  '',    buildQuartierSystem);
  defineZone('Port · Marché mondial',      102,  2, COL.bleu,   '',    buildPort);

  buildMainStreet();   // v52 : la grand-rue, épine dorsale visible dès le premier instant
  buildGroundPatches();// M3 — transitions de classe au sol (4 matières distinctes)
  buildPuddles();      // M3 — flaques réfléchissantes : seules surfaces non mates du sol
  buildGroundDebris(); // M3 — papiers / éclats / pierres en InstancedMesh
  buildWaterEast();    // v56/M6 : littoral — eau étendue jusqu'à l'horizon (M6-bord)
  buildLighthouse();   // M-Mer/B : phare + faisceau tournant sur môle pierre
  buildMaritimeTraffic();// M-Mer/C : voiliers + vapeur en patrouille (sillages, fumée)
  buildSeaFauna();     // M-Mer/D : crabes, mouettes, bouées, banc de poissons
  _M_Mer_buildShoreFoam(); // M-Mer/correctif-rivage : ligne d'écume au ressac
  Nature.build();      // v57 : forêts et herbe instanciées — la nature précède le capital (visible dès la phase 0)
  buildClosingHorizon();// M6-bord : ferme le monde par géographie naturelle (collines, estran, voiliers distants)
  // v61 : le tube doré permanent est RETIRÉ (confus entre les bâtiments). Le guidage
  // passe par la barre du circuit (UI), la balise, la flèche au sol et la ligne
  // TEMPORAIRE du tutoriel (circuitLine), qui s'éteint après le premier circuit.
}

let _M4_currentZone=null;            // M4 : tag de zone propagé à createWindow
function defineZone(name,x,z,color,key,builder){
  const group=new THREE.Group(); group.position.set(x,0,z);
  _M4_currentZone=name;
  builder(group,color);
  _M4_currentZone=null;
  group.children.forEach(m=>{ if(m.userData) m.userData.base=true; });  // structure de base (masquable)
  const label=makeLabel(key?`${key} — ${name}`:name); label.position.set(0,8,0);
  // M-Peaufinage/D : tag pour le fade-par-distance (lisible de loin,
  //   discret de près pour ne pas masquer la scène quand on est sur place).
  label.userData.zoneSign = true; _zoneSigns.push(label);
  group.add(label);
  // halo au sol
  const halo=new THREE.Mesh(new THREE.RingGeometry(7.4,8.2,40),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity:.35,side:THREE.DoubleSide}));
  halo.rotation.x=-Math.PI/2; halo.position.y=0.04; group.add(halo);
  scene.add(group);

  const actionMap={
    'Banque':'banque','Marché des moyens':'marcheMP','Marché du travail':'marcheTravail',
    'Usine':'usine','Entrepôt':'entrepot','Marché de vente':'marcheVente',
    'Quartier ouvrier':'quartier','État · Tribunal':'etat','Terres communes':'terres',
    'Mines · Champs':'mines','Port · Marché mondial':'port','Bourse':'bourse'
  };
  zoneGroups[name]=group;
  zones.push({name,pos:new THREE.Vector3(x,0,z),radius:8,key,group,halo,
    action:()=>MiniCircuit[actionMap[name]]()});
  obstacles.push({pos:new THREE.Vector2(x,z),radius:5.5});
}

/* =====================================================================
   M5 — TEXTURES & HELPERS DES BÂTIMENTS DE POUVOIR.
   pierreDeTaille + enduit suivent le modèle M3 ({map, roughnessMap}, 512px,
   anisotropy 8, RepeatWrapping). Helpers archi : fenêtre cintrée (avec
   pane taggé pour M4), grille de fer, portes/lanternes en bronze,
   forme rectangle arrondie pour ExtrudeGeometry (biseaux ~3 cm).
   Toutes les textures sont memoïsées (1 material par texture, partagé
   entre faces). Voir buildBanque / buildBourse / buildEtat plus bas.
   ===================================================================== */
const _M5_tex = {};
// Object3D.add() retourne le PARENT, pas l'enfant — d'où ce helper qui
// ajoute le mesh au parent en lui posant sa position et retourne le mesh.
const _addAt=(parent, mesh, x=0, y=0, z=0)=>{
  mesh.position.set(x,y,z); parent.add(mesh); return mesh;
};
function pierreDeTailleTexture(tone='clair'){
  const key='pierreDT_'+tone; if(_M5_tex[key]) return _M5_tex[key];
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0xb1a98e + (tone==='sombre'?7919:tone==='froid'?9181:0));
  const PALETTE = tone==='sombre' ? [154,141,118] : tone==='froid' ? [148,156,170] : [188,176,154];
  const JOINT = tone==='froid' ? '#525766' : '#6b6149';
  x.fillStyle=JOINT; x.fillRect(0,0,512,512);
  r.fillStyle='#eaeaea'; r.fillRect(0,0,512,512);
  // appareil pierre de taille : grandes assises horizontales, blocs décalés
  const ROW_H=80;
  for(let row=0, y=2; y<530; y+=ROW_H, row++){
    const off=(row%2)? -72 : 0;
    for(let cx=off; cx<540; cx+=144){
      const w=144-5+(rnd()-0.5)*5;
      const h=ROW_H-5;
      const dr=(rnd()-0.5)*18, dg=(rnd()-0.5)*16, db=(rnd()-0.5)*14;
      x.fillStyle=`rgb(${Math.max(40,PALETTE[0]+dr)},${Math.max(40,PALETTE[1]+dg)},${Math.max(40,PALETTE[2]+db)})`;
      x.fillRect(cx+3, y, w, h);
      const rg=212+Math.floor(rnd()*22);
      r.fillStyle=`rgb(${rg},${rg},${rg})`;
      r.fillRect(cx+4, y+1, w-2, h-2);
      // ombre fine en haut/bas (chamfer dessiné — biseaux sous-pixel)
      x.fillStyle='rgba(0,0,0,0.18)'; x.fillRect(cx+3, y, w, 2);
      x.fillStyle='rgba(255,255,255,0.06)'; x.fillRect(cx+3, y+2, w, 1);
      x.fillStyle='rgba(0,0,0,0.10)'; x.fillRect(cx+3, y+h-2, w, 2);
      // grain & micro-érosion
      if(rnd()<0.5){
        x.fillStyle='rgba(0,0,0,0.06)';
        for(let k=0;k<6;k++) x.fillRect(cx+8+rnd()*(w-12), y+4+rnd()*(h-6), 1+rnd()*2, 1+rnd()*1.5);
      }
    }
  }
  const tex={ map:_texColor(c), roughnessMap:_texLinear(rc) };
  _M5_tex[key]=tex; return tex;
}
function enduitTexture(){
  if(_M5_tex.enduit) return _M5_tex.enduit;
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0x8c93a4);
  x.fillStyle='#9aa0ad'; x.fillRect(0,0,512,512);
  r.fillStyle='#f0f0f0'; r.fillRect(0,0,512,512);
  // micro-grain pebbledash
  for(let i=0;i<2600;i++){
    const px=rnd()*512, py=rnd()*512, dark=rnd()<0.5;
    x.fillStyle=dark?`rgba(60,68,80,${0.10+rnd()*0.18})`:`rgba(220,228,236,${0.08+rnd()*0.14})`;
    x.fillRect(px,py, 1+rnd()*1.5, 1+rnd()*1.5);
  }
  // larges plaques d'usure subtile
  for(let i=0;i<10;i++){
    const px=rnd()*512, py=rnd()*512, rr=60+rnd()*80;
    const gr=x.createRadialGradient(px,py,rr*0.2,px,py,rr);
    gr.addColorStop(0,'rgba(50,56,68,0.10)'); gr.addColorStop(1,'rgba(50,56,68,0)');
    x.fillStyle=gr; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
  }
  const tex={ map:_texColor(c), roughnessMap:_texLinear(rc) };
  _M5_tex.enduit=tex; return tex;
}

/* =====================================================================
   M6 — TEXTURES PBR DE LA PRODUCTION.
   briqueTexture : brique sombre 0x5a3026 (industrie XIXe), joints, briques
   cassées éparses, suie en partie haute (variante 'haut'). Plusieurs
   variantes (standard / sale / décrépit) calibrées sur le CRESCENDO D'USURE.
   toleTexture : tôle ondulée corrosive, joints + rivets, taches de rouille.
   ===================================================================== */
function briqueTexture(variant='std'){
  const key='brique_'+variant; if(_M5_tex[key]) return _M5_tex[key];
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0x5a3026 + (variant==='sale'?7919:variant==='decrep'?3571:variant==='haut'?5119:0));
  // joints + base
  x.fillStyle='#2d1810'; x.fillRect(0,0,512,512);
  r.fillStyle='#e8e8e8'; r.fillRect(0,0,512,512);
  // appareil brique : rangées décalées, briques 32×16
  const BW=64, BH=22;
  for(let row=0, y=0; y<530; y+=BH, row++){
    const off=(row%2)? -BW/2 : 0;
    for(let bx=off; bx<540; bx+=BW){
      const dr=(rnd()-0.5)*22, dg=(rnd()-0.5)*16, db=(rnd()-0.5)*12;
      const baseR=0x5a + dr, baseG=0x30 + dg, baseB=0x26 + db;
      x.fillStyle=`rgb(${baseR},${baseG},${baseB})`;
      x.fillRect(bx+2, y+1, BW-3, BH-2);
      const rg=210+Math.floor(rnd()*22);
      r.fillStyle=`rgb(${rg},${rg},${rg})`;
      r.fillRect(bx+3, y+2, BW-5, BH-4);
      // ombre subtile haut/bas (3D)
      x.fillStyle='rgba(0,0,0,0.22)'; x.fillRect(bx+2, y+1, BW-3, 1);
      x.fillStyle='rgba(255,255,255,0.05)'; x.fillRect(bx+2, y+2, BW-3, 1);
      x.fillStyle='rgba(0,0,0,0.12)'; x.fillRect(bx+2, y+BH-2, BW-3, 1);
      // briques cassées (5-12%)
      if(rnd() < (variant==='decrep'?0.18:variant==='sale'?0.10:0.05)){
        x.fillStyle='rgba(20,12,8,0.50)';
        const ch=2+rnd()*5, cw=8+rnd()*16;
        x.fillRect(bx+4+rnd()*(BW-12), y+rnd()*(BH-4), cw, ch);
      }
      // grain
      if(rnd()<0.6){
        x.fillStyle='rgba(0,0,0,0.06)';
        for(let k=0;k<5;k++) x.fillRect(bx+4+rnd()*(BW-6), y+2+rnd()*(BH-4), 1+rnd()*2, 1);
      }
    }
  }
  // SUIE en partie haute (variante 'haut') — gradient sombre vertical
  if(variant==='haut' || variant==='sale' || variant==='decrep'){
    const grSize = variant==='haut'?0.55 : variant==='decrep'?0.40 : 0.30;
    const g=x.createLinearGradient(0,0,0,512);
    g.addColorStop(0,'rgba(8,6,4,'+grSize+')');
    g.addColorStop(0.55,'rgba(20,14,8,'+(grSize*0.5)+')');
    g.addColorStop(1,'rgba(20,14,8,0)');
    x.fillStyle=g; x.fillRect(0,0,512,512);
    // taches de suie aléatoires en partie haute
    for(let i=0;i<24;i++){
      const px=rnd()*512, py=rnd()*220, rr=18+rnd()*40;
      const gr=x.createRadialGradient(px,py,rr*0.2,px,py,rr);
      gr.addColorStop(0,'rgba(8,6,4,'+(0.20+rnd()*0.25)+')');
      gr.addColorStop(1,'rgba(8,6,4,0)');
      x.fillStyle=gr; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
    }
  }
  // décrépitude : plâtre/enduit qui se décolle (variante 'decrep' pour quartier ouvrier)
  if(variant==='decrep'){
    for(let i=0;i<8;i++){
      const px=rnd()*512, py=rnd()*512, w=80+rnd()*120, h=40+rnd()*80;
      const tone=180+Math.floor(rnd()*40);
      x.fillStyle=`rgba(${tone},${tone-12},${tone-26},${0.45+rnd()*0.25})`;
      x.fillRect(px, py, w, h);
      x.strokeStyle='rgba(20,14,8,0.30)'; x.lineWidth=1.4;
      x.strokeRect(px, py, w, h);
    }
  }
  const tex={ map:_texColor(c), roughnessMap:_texLinear(rc) };
  _M5_tex[key]=tex; return tex;
}
function toleTexture(){
  if(_M5_tex.tole) return _M5_tex.tole;
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0x4a4642);
  // base gris tôle
  x.fillStyle='#5a564f'; x.fillRect(0,0,512,512);
  r.fillStyle='#dadada'; r.fillRect(0,0,512,512);
  // ondulations verticales (alternance bandes claire/sombre)
  for(let bx=0; bx<512; bx+=32){
    const grad=x.createLinearGradient(bx,0,bx+32,0);
    grad.addColorStop(0,'rgba(0,0,0,0.30)');
    grad.addColorStop(0.5,'rgba(255,255,255,0.10)');
    grad.addColorStop(1,'rgba(0,0,0,0.30)');
    x.fillStyle=grad; x.fillRect(bx,0,32,512);
  }
  // rivets horizontaux (rangées espacées)
  for(let y=24; y<512; y+=110){
    for(let bx=16; bx<512; bx+=32){
      x.fillStyle='#2c2820';
      x.beginPath(); x.arc(bx, y, 2.6, 0, Math.PI*2); x.fill();
      x.fillStyle='rgba(120,108,92,0.7)';
      x.beginPath(); x.arc(bx-0.6, y-0.6, 1.4, 0, Math.PI*2); x.fill();
    }
  }
  // taches de rouille
  for(let i=0;i<22;i++){
    const px=rnd()*512, py=rnd()*512, rr=12+rnd()*40;
    const gr=x.createRadialGradient(px,py,rr*0.2,px,py,rr);
    gr.addColorStop(0,'rgba(126,58,28,'+(0.32+rnd()*0.30)+')');
    gr.addColorStop(1,'rgba(126,58,28,0)');
    x.fillStyle=gr; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
  }
  // grain global
  for(let i=0;i<900;i++){
    x.fillStyle=rnd()<0.5?`rgba(0,0,0,${0.05+rnd()*0.10})`:`rgba(220,210,196,${0.05+rnd()*0.08})`;
    x.fillRect(rnd()*512, rnd()*512, 1+rnd()*1.5, 1);
  }
  const tex={ map:_texColor(c), roughnessMap:_texLinear(rc) };
  _M5_tex.tole=tex; return tex;
}
// rectangle arrondi (pour ExtrudeGeometry, donne biseaux ~3cm via bevelSize)
function _roundedRectShape(w, d, r){
  const W=w/2, D=d/2;
  const s=new THREE.Shape();
  s.moveTo(-W+r, -D);
  s.lineTo(W-r, -D); s.quadraticCurveTo(W, -D, W, -D+r);
  s.lineTo(W, D-r);   s.quadraticCurveTo(W, D, W-r, D);
  s.lineTo(-W+r, D);  s.quadraticCurveTo(-W, D, -W, D-r);
  s.lineTo(-W, -D+r); s.quadraticCurveTo(-W, -D, -W+r, -D);
  return s;
}
/* createArchedWindow — fenêtre cintrée. Le pane est taggé _M4_currentZone et
   poussé dans windowPanes pour que updateWindowGlow l'allume comme une vitre
   classique (gold pour banque/bourse, etc.) */
function createArchedWindow(w=1.0, h=2.4, frameC=0x352a1e){
  const g=new THREE.Group();
  const ah=w*0.5;
  const shp=new THREE.Shape();
  shp.moveTo(-w/2, 0);
  shp.lineTo(-w/2, h - ah);
  shp.absarc(0, h - ah, ah, Math.PI, 0, true);
  shp.lineTo(w/2, 0);
  shp.lineTo(-w/2, 0);
  // vitre (pane M4-taggé)
  const paneGeo=new THREE.ShapeGeometry(shp);
  const pane=new THREE.Mesh(paneGeo, new THREE.MeshStandardMaterial({
    color:0x33414c, emissive:new THREE.Color(0x12202a), emissiveIntensity:0.5,
    flatShading:true, roughness:0.7,
  }));
  pane.position.z=0.0;
  pane.userData.glowPhase=Math.random();
  pane.userData.zone=_M4_currentZone;
  windowPanes.push(pane);
  g.add(pane);
  // cadre dormant (outline plus large, plus sombre derrière)
  const fr=0.10;
  const outShp=new THREE.Shape();
  outShp.moveTo(-w/2 - fr, -fr);
  outShp.lineTo(-w/2 - fr, h - ah);
  outShp.absarc(0, h - ah, ah + fr, Math.PI, 0, true);
  outShp.lineTo(w/2 + fr, -fr);
  outShp.lineTo(-w/2 - fr, -fr);
  const out=new THREE.Mesh(new THREE.ShapeGeometry(outShp),
    new THREE.MeshStandardMaterial({color:frameC, roughness:0.9, flatShading:true}));
  out.position.z=-0.06;
  g.add(out);
  // archivolt (demi-torus sur l'arc)
  const arch=new THREE.Mesh(new THREE.TorusGeometry(ah + fr*0.6, 0.05, 4, 16, Math.PI),
    new THREE.MeshStandardMaterial({color:frameC, roughness:0.7, flatShading:true}));
  arch.position.set(0, h - ah, 0.06);
  g.add(arch);
  // clé de voûte (saillie centrale)
  g.add(box(0.20, 0.36, 0.14, 0x86795b, 0, h - 0.06, 0.07, false));
  return g;
}
function createIronGrille(w=1.0, h=1.0, color=0x14181f){
  const g=new THREE.Group();
  const matIron=new THREE.MeshStandardMaterial({color, roughness:0.5, metalness:0.7, flatShading:true});
  const bars=5;
  for(let i=0;i<bars;i++){
    const bx=-w/2 + (i+0.5)*(w/bars);
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), matIron), bx, h/2, 0);
  }
  for(const y of [h*0.18, h*0.82])
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(w+0.08, 0.05, 0.05), matIron), 0, y, 0);
  for(const sx of [-1,1])
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(0.06, h+0.1, 0.06), matIron), sx*w/2, h/2, 0);
  return g;
}
function createIronFence(len=11, height=1.8){
  const g=new THREE.Group();
  const matIron=new THREE.MeshStandardMaterial({color:0x14181f, roughness:0.5, metalness:0.7, flatShading:true});
  const matStone=new THREE.MeshStandardMaterial({color:0x6b7080, roughness:0.95, metalness:0});
  const bars=Math.floor(len/0.5);
  for(let i=0;i<=bars;i++){
    const bx=-len/2 + i*(len/bars);
    _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, height, 6), matIron), bx, height/2, 0);
    _addAt(g, new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 6), matIron), bx, height + 0.09, 0);
  }
  for(const y of [0.35, height - 0.12])
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.07), matIron), 0, y, 0);
  for(const sx of [-1,1])
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(0.32, height+0.6, 0.32), matStone),
      sx*(len/2 + 0.15), (height+0.6)/2, 0);
  return g;
}
function createBronzeDoor(w=2.8, h=4.2){
  const g=new THREE.Group();
  const matBronze=new THREE.MeshStandardMaterial({color:0x6b5a35, roughness:0.45, metalness:0.75, flatShading:true});
  const matBronzeDark=new THREE.MeshStandardMaterial({color:0x4a3e22, roughness:0.6, metalness:0.7, flatShading:true});
  const matFrame=new THREE.MeshStandardMaterial({color:0x9b906f, roughness:0.95, metalness:0});
  // chambranle de pierre épaisse
  _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(w+0.6, h+0.4, 0.18), matFrame), 0, h/2 + 0.05, -0.05);
  // double battant
  for(const sx of [-1,1]){
    const lw=w/2 - 0.05;
    const leaf=new THREE.Mesh(new THREE.BoxGeometry(lw, h, 0.10), matBronze);
    leaf.position.set(sx*(w/4 + 0.025), h/2, 0.06);
    leaf.castShadow=true; g.add(leaf);
    // 3 panneaux moulurés par battant (encastrés)
    for(let i=0;i<3;i++){
      const pw=lw - 0.30, ph=(h - 0.9)/3 - 0.15;
      const py=0.45 + i*((h-0.9)/3) + ph/2;
      _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.03), matBronzeDark),
        sx*(w/4 + 0.025), py, 0.115);
    }
    // poignée
    _addAt(g, new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), matBronze),
      sx*(w/3 - 0.1), h*0.42, 0.16);
  }
  // linteau au-dessus de la porte (saillant)
  _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(w+0.8, 0.22, 0.28), matFrame), 0, h + 0.18, 0.05);
  return g;
}
/* createBronzeLantern — PAS de PointLight (M4 budget intact). Faux halo via
   sprite additif + bulbe émissif goldLight (nourrit le bloom). */
function createBronzeLantern(){
  const g=new THREE.Group();
  const matBronze=new THREE.MeshStandardMaterial({color:0x6b5a35, roughness:0.45, metalness:0.75, flatShading:true});
  const matBronzeDark=new THREE.MeshStandardMaterial({color:0x4a3e22, roughness:0.6, metalness:0.7, flatShading:true});
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 3.6, 6), matBronze), 0, 1.8, 0);
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.25, 8), matBronzeDark), 0, 0.12, 0);
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.15, 8), matBronze), 0, 3.65, 0);
  for(let i=0;i<4;i++){
    const a=i*Math.PI/2;
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 0.04), matBronze),
      Math.cos(a)*0.20, 3.95, Math.sin(a)*0.20);
  }
  const top=new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.36, 4), matBronzeDark);
  top.rotation.y=Math.PI/4; top.position.y=4.35; g.add(top);
  // bulbe émissif goldLight (nourrit le bloom)
  _addAt(g, new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8),
    new THREE.MeshStandardMaterial({color:0xffe6ad, emissive:new THREE.Color(0xffd98a), emissiveIntensity:1.6, flatShading:true})),
    0, 3.95, 0);
  // halo additif (sprite)
  _gasTextures();
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({
    map:_gasHaloTex, color:0xffd98a, transparent:true, opacity:0.55,
    depthWrite:false, blending:THREE.AdditiveBlending,
  }));
  halo.scale.set(2.4, 2.4, 1); halo.position.y=3.95;
  g.add(halo);
  return g;
}
/* _cotationsTex — bandeau défilant de cotations boursières. Texture animée
   par offset.x (cf. updateBourseSkin). */
let _M5_cotationsTex = null;
function _cotationsTexture(){
  if(_M5_cotationsTex) return _M5_cotationsTex;
  const c=document.createElement('canvas'); c.width=1024; c.height=64;
  const x=c.getContext('2d');
  x.fillStyle='#15181c'; x.fillRect(0,0,1024,64);
  x.font='700 32px "IBM Plex Mono", monospace';
  x.textBaseline='middle';
  const items=['£INDEX 142.8 ▲','£BANK 89.2 ▼','£RAIL 215.6 ▲','£TEX 68.0 ▼','£STEEL 432.1 ▲','£SUGAR 17.4 ▼','£COTON 41.3 ▲','£EAST 12.0 ▼'];
  let px=18;
  for(const it of items){
    x.fillStyle = it.includes('▲') ? '#9ad17a' : '#d17a7a';
    x.fillText(it, px, 32);
    px += x.measureText(it).width + 50;
  }
  const t=new THREE.CanvasTexture(c);
  t.wrapS=THREE.RepeatWrapping; t.wrapT=THREE.ClampToEdgeWrapping;
  _M5_cotationsTex=t; return t;
}

/* --- silhouettes low-poly par zone --- */
let _M5_bourseCoin = null;    // pour la rotation lente de la girouette
function buildBanque(g){
  // — matières partagées (1 material par texture)
  const pierre=pierreDeTailleTexture('clair');
  const matStone=new THREE.MeshStandardMaterial({
    color:0xb8ad98, map:pierre.map, roughnessMap:pierre.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  const matStoneDark=new THREE.MeshStandardMaterial({
    color:0x9b906f, map:pierre.map, roughnessMap:pierre.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  const matStain=new THREE.MeshBasicMaterial({
    color:0x3a2f24, transparent:true, opacity:0.32, depthWrite:false,
  });

  // helper local : box() crée son propre material — on le SWAP par celui partagé
  // (sinon chaque box porte son propre MeshStandardMaterial sans map). Object3D.add
  // retourne le PARENT, donc on ne peut pas chaîner ; on instancie séparément.
  const swap=(m, mat)=>{ m.material=mat; return m; };

  // ---------- SOUBASSEMENT débordant (M5b — ancrage au sol) ----------
  // Slab plus large que la plinthe, partiellement enterré : le bâtiment
  // n'est plus posé en équilibre sur le terrain — il « tient ».
  const soubShape=_roundedRectShape(13.6, 11.6, 0.12);
  const soubGeo=new THREE.ExtrudeGeometry(soubShape,{depth:0.55,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  soubGeo.rotateX(-Math.PI/2); soubGeo.translate(0,-0.20,0);
  const soub=new THREE.Mesh(soubGeo, matStoneDark); soub.receiveShadow=true;
  g.add(soub);

  // ---------- PARVIS + MARCHES (rapport au sol) ----------
  g.add(swap(box(15, 0.18, 5.4, 0xc6bb9d, 0, 0.09, 4.6, false), matStoneDark));
  for(let i=0;i<4;i++){
    const sw=13 - i*0.7;
    g.add(swap(box(sw, 0.32, 0.95, 0xb8ad98, 0, 0.16+i*0.32, 2.0 + i*0.95, false), matStone));
  }

  // ---------- PLINTHE (extrude, biseaux) ----------
  const plinShape=_roundedRectShape(13, 11, 0.10);
  const plinGeo=new THREE.ExtrudeGeometry(plinShape,{depth:1.2,bevelEnabled:true,
    bevelSize:0.06,bevelThickness:0.06,bevelSegments:1,steps:1});
  plinGeo.rotateX(-Math.PI/2);
  const plin=new THREE.Mesh(plinGeo, matStoneDark); plin.castShadow=true; plin.receiveShadow=true;
  g.add(plin);

  // ---------- CORPS pierre de taille claire ----------
  const bodyShape=_roundedRectShape(11.5, 9.5, 0.08);
  const bodyGeo=new THREE.ExtrudeGeometry(bodyShape,{depth:9.0,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  bodyGeo.rotateX(-Math.PI/2); bodyGeo.translate(0,1.2,0);
  const body=new THREE.Mesh(bodyGeo, matStone); body.castShadow=true; body.receiveShadow=true;
  g.add(body);

  // ---------- FRISE + CORNICHE (large débord) ----------
  // frise mince à mi-hauteur (rappel des cours d'assises)
  g.add(swap(box(11.8, 0.30, 9.8, 0xa8957a, 0, 6.8, 0, false), matStoneDark));
  // corniche en débord, biseautée
  const corShape=_roundedRectShape(13.4, 11.4, 0.12);
  const corGeo=new THREE.ExtrudeGeometry(corShape,{depth:0.62,bevelEnabled:true,
    bevelSize:0.08,bevelThickness:0.08,bevelSegments:1,steps:1});
  corGeo.rotateX(-Math.PI/2); corGeo.translate(0,10.2,0);
  const corniche=new THREE.Mesh(corGeo, matStoneDark); corniche.castShadow=true;
  g.add(corniche);
  // bande de pluie sous la corniche (usure DISCRÈTE — temple entretenu)
  const stainBand=new THREE.Mesh(new THREE.PlaneGeometry(11.5, 0.7), matStain);
  stainBand.position.set(0, 9.7, 4.78); g.add(stainBand);

  // ---------- 6 COLONNES sous le portique ----------
  for(let i=0;i<6;i++){
    const c=createColumn(8.8, 0.46);
    c.position.set(-5 + i*2, 1.2, 4.95);
    g.add(c);
  }

  // ---------- FRONTON TRIANGULAIRE + frise ----------
  const pediShape=new THREE.Shape();
  pediShape.moveTo(-6.6, 0); pediShape.lineTo(6.6, 0);
  pediShape.lineTo(0, 2.8); pediShape.lineTo(-6.6, 0);
  const pediGeo=new THREE.ExtrudeGeometry(pediShape,{depth:1.5,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  pediGeo.translate(0, 10.5, 4.0);
  const pediment=new THREE.Mesh(pediGeo, matStone); pediment.castShadow=true;
  g.add(pediment);
  // « £ » sculpté en relief au tympan
  const sp=createSign('£'); sp.scale.set(2.4,2.4,1); sp.position.set(0, 11.6, 5.55); g.add(sp);

  // ---------- FENÊTRES CINTRÉES (alignées sur l'émissif goldLight M4) ----------
  // 4 fenêtres en façade entre les colonnes, à hauteur ~7m
  for(const fx of [-3.0, -1.0, 1.0, 3.0]){
    const w=createArchedWindow(1.0, 2.4);
    w.position.set(fx, 5.0, 4.78);
    g.add(w);
    // grille de fer au niveau bas
    const gr=createIronGrille(1.0, 1.0);
    gr.position.set(fx, 4.6, 4.85); g.add(gr);
  }
  // 2 fenêtres cintrées hautes au-dessus (illuminent depuis l'intérieur)
  for(const fx of [-2.0, 2.0]){
    const w=createArchedWindow(0.9, 1.9);
    w.position.set(fx, 7.3, 4.78); g.add(w);
  }
  // côtés : 3 fenêtres cintrées par flanc (le volume n'est plus aveugle)
  for(const sx of [-1, 1]){
    for(const fz of [-2.5, 0, 2.5]){
      const w=createArchedWindow(0.9, 2.1);
      w.position.set(sx*5.78, 5.2, fz);
      w.rotation.y=sx>0?-Math.PI/2:Math.PI/2;
      g.add(w);
    }
    // M5b — frise latérale qui reprend le bandeau de façade (continuité du volume)
    const sideFrize=swap(box(0.30, 0.30, 9.6, 0xa8957a, sx*5.81, 6.8, 0, false), matStoneDark);
    g.add(sideFrize);
  }
  // ---------- FAÇADE ARRIÈRE (M5b — plus sobre que devant, mais TRAITÉE) ----------
  // 4 fenêtres + frise + corniche déjà courent autour (ExtrudeGeometry)
  for(const fx of [-3.4, -1.1, 1.1, 3.4]){
    const w=createArchedWindow(0.85, 2.0);
    w.position.set(fx, 5.0, -4.78);
    w.rotation.y=Math.PI;
    g.add(w);
  }
  // 2 lucarnes carrées hautes à l'arrière
  for(const fx of [-2.2, 2.2]){
    const w=createWindow(0.7, 0.85);
    w.position.set(fx, 7.7, -4.80);
    w.rotation.y=Math.PI; g.add(w);
  }
  // petite porte de service au centre arrière
  const backDoor=swap(box(1.6, 2.4, 0.10, 0x352a1e, 0, 1.2, -4.80, false), matStoneDark);
  g.add(backDoor);

  // ---------- TOIT FERMÉ : dalle sombre derrière le fronton ----------
  // Le corps + corniche referment déjà le volume par le haut. On ajoute une
  // dalle plus sombre légèrement saillante : c'est le toit visible d'en haut.
  const roof=swap(box(11.4, 0.25, 9.4, 0x55483a, 0, 10.92, 0, false), matStoneDark);
  roof.material=new THREE.MeshStandardMaterial({color:0x55483a, roughness:0.95, metalness:0});
  g.add(roof);

  // ---------- PORTE DE BRONZE (double battant) ----------
  const door=createBronzeDoor(2.6, 4.0);
  door.position.set(0, 0, 4.80); g.add(door);

  // ---------- 2 LANTERNES DE BRONZE encadrant l'entrée ----------
  for(const sx of [-1, 1]){
    const lant=createBronzeLantern();
    lant.position.set(sx*2.4, 0, 5.6); g.add(lant);
  }

  // ---------- COFFRE + REGISTRES (clin d'œil, côté coulisses) ----------
  const coffre=box(2.4,2,1.8,0x3a352c,4.4,1.5,-3,false); coffre.material.map=texMetal(); g.add(coffre);
  g.add(box(2.5,0.4,1.9,COL.or,4.4,2.5,-3,false));
  for(let i=0;i<3;i++) g.add(box(1.7,0.42,1.1,0xcdbd9a,-4.6,0.7+i*0.46,-3,false));
}
/* ===== v64 — KIT DE FAÇADE : ce qui sépare une boîte d'un bâtiment =====
   soubassement de pierre, corniche sous le toit, fenêtres à volets,
   faîtage, lucarne, chapeau de cheminée, auvent de quai. Réutilisé par
   les trois stades d'usine et la maison ouvrière. */
function addPlinth(put,w,d,h=0.55){           // soubassement : pierre sombre, légèrement saillant
  const m=put(box(w+0.34,h,d+0.34,0x7e7565,0,h/2,0)); m.material.map=texBrick(); return m; }
function addCornice(put,w,d,y){               // corniche : bandeau saillant sous le toit
  return put(box(w+0.5,0.28,d+0.5,0x6e6354,0,y,0,false)); }
function addRidge(put,len,y,alongX=true){     // faîtage : baguette sur l'arête du toit
  const r=new THREE.Mesh(new THREE.CylinderGeometry(0.14,0.14,len,6),
    new THREE.MeshStandardMaterial({color:0x3a3028,flatShading:true}));
  r.rotation.z=alongX?Math.PI/2:0; if(!alongX) r.rotation.x=Math.PI/2;
  r.position.y=y; put(r); return r; }
function createShutterWindow(w=0.9,h=1.0){    // fenêtre à volets entrouverts
  const g=createWindow(w,h);
  for(const sgn of [-1,1]){
    const v=box(w*0.52,h+0.1,0.06,0x5a6a4a,sgn*(w/2+w*0.30),0,0.06,false);
    v.rotation.y=sgn*0.5; g.add(v);
  }
  return g; }
function createDormer(){                      // lucarne : petit volume + toit + fenêtre
  const g=new THREE.Group();
  g.add(box(1.2,1.1,1.0,0x9c8f74,0,0.55,0,false));
  const t=new THREE.Mesh(new THREE.ConeGeometry(0.95,0.7,4),
    new THREE.MeshStandardMaterial({color:0x46393b,flatShading:true}));
  t.rotation.y=Math.PI/4; t.position.y=1.45; g.add(t);
  const w=createWindow(0.6,0.6); w.position.set(0,0.55,0.53); g.add(w);
  return g; }
function addChimneyCap(put,x,y,z){            // chapeau + mitron
  put(box(2.0,0.34,2.0,0x6e6354,x,y,z,false));
  const pot=new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.34,0.7,7),
    new THREE.MeshStandardMaterial({color:0x8a5a3e,flatShading:true}));
  pot.position.set(x+0.45,y+0.5,z); put(pot); }
function addAwning(put,w,x,y,z){              // auvent de quai : toile inclinée + potences
  const t=box(w,0.1,2.0,0x8a3b2a,x,y,z+1.0,false); t.rotation.x=0.3; put(t);
  for(const sx of [-1,1]) put(box(0.12,0.12,2.0,0x3a3028,x+sx*w/2*0.9,y-0.28,z+1.0,false)).rotation.x=0.3; }

/* =====================================================================
   v53 — GRAMMAIRE ARCHITECTURALE COMMUNE.
   Le monde applique les MÊMES règles à tous les capitaux : un atelier est
   un atelier, qu'il soit à toi ou à Brandt. Trois stades, un seul
   vocabulaire — la parcelle du joueur et celles des concurrents sont
   construites par les mêmes fonctions, à la même échelle.
     stade 1 : ATELIER (fondation)        stade 2 : MANUFACTURE
     stade 3 : GRANDE INDUSTRIE (l'ancienne « grande usine » du joueur,
               qui s'affichait à tort dès la fondation)
   `put` est le placeur fourni par l'appelant : il décide du calque
   ('plant' chez le joueur, 'cw' chez les firmes) — même pierre, autre main.
   ===================================================================== */
/* =====================================================================
   M6 — HELPERS DES BÂTIMENTS DE LA PRODUCTION.
   _M6_pitchedClosed : 2 pans + 2 pignons + faîtage en un Group — ferme
   réellement le volume (les anciens createRoof laissaient les pignons
   ouverts, d'où des intérieurs visibles).
   _M6_sawtoothShed   : sheds dentés avec verrières émissives forgeLight
   (tag M4 = couplage production).
   ===================================================================== */
function _M6_pitchedClosed(w, d, rise, matRoof, matGable){
  const g=new THREE.Group();
  const len=Math.hypot(w/2, rise);
  const slope=Math.atan2(rise, w/2);
  for(const sx of [-1, 1]){
    const p=new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, d + 0.4), matRoof);
    p.rotation.z=-sx*slope;
    p.position.set(sx*w/4, rise/2, 0);
    p.castShadow=true; p.receiveShadow=true;
    g.add(p);
  }
  // faîtage
  const ridge=new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, d + 0.2), matRoof);
  ridge.position.y=rise; g.add(ridge);
  // pignons (triangles fermant le volume aux extrémités Z)
  for(const sz of [-1, 1]){
    const shp=new THREE.Shape();
    shp.moveTo(-w/2, 0); shp.lineTo(w/2, 0);
    shp.lineTo(0, rise); shp.lineTo(-w/2, 0);
    const geo=new THREE.ExtrudeGeometry(shp, {depth: 0.16, bevelEnabled:false});
    const gable=new THREE.Mesh(geo, matGable);
    gable.position.set(0, 0, sz*(d/2) - (sz<0 ? -0.16 : 0));
    if(sz < 0){ gable.rotation.y=Math.PI; gable.position.z += 0.16; }
    gable.castShadow=true;
    g.add(gable);
  }
  return g;
}
function _M6_sawtoothShed(w, d, matRoof, matGlass){
  // sheds (dents de scie). Chaque dent : mur incliné nord-sombre + verrière inclinée sud-émissive.
  // matGlass.userData.m4Role='usine-verriere' pour le couplage M4.
  const g=new THREE.Group();
  const n=Math.max(2, Math.floor(w/3.2));
  const tw=w/n;
  for(let i=0;i<n;i++){
    const x=-w/2 + (i+0.5)*tw;
    // pan opaque (revers nord, sombre)
    const back=new THREE.Mesh(new THREE.BoxGeometry(tw*0.55, 1.95, d), matRoof);
    back.position.set(x - tw*0.20, 0.97, 0); g.add(back);
    // verrière (sud, inclinée, émissive)
    const glass=new THREE.Mesh(new THREE.BoxGeometry(tw*0.65, 1.75, d*0.96), matGlass);
    glass.position.set(x + tw*0.18, 1.08, 0);
    glass.rotation.z=-0.66;
    g.add(glass);
  }
  // base — un toit plat en dessous pour fermer le tout (pas de trou regardé d'en haut)
  const base=new THREE.Mesh(new THREE.BoxGeometry(w, 0.20, d), matRoof);
  base.position.y=0.10; g.add(base);
  return g;
}
function _M6_addClosingGables(parent, w, d, corpsTopY, rise, mat){
  // ferme les pignons au bout d'un toit pitched simple (déjà créé par createRoof)
  // pour les cas où on garde l'ancien createRoof.
  for(const sz of [-1, 1]){
    const shp=new THREE.Shape();
    shp.moveTo(-w/2, 0); shp.lineTo(w/2, 0);
    shp.lineTo(0, rise); shp.lineTo(-w/2, 0);
    const geo=new THREE.ExtrudeGeometry(shp, {depth: 0.16, bevelEnabled:false});
    const gable=new THREE.Mesh(geo, mat);
    gable.position.set(0, corpsTopY, sz*(d/2));
    if(sz < 0) gable.rotation.y=Math.PI;
    parent.add(gable);
  }
}

function buildPlantStage1(g,put){           // l'ATELIER — artisanal, chaleureux, bois + torchis
  // matières
  const torchis=new THREE.MeshStandardMaterial({color:0xc8a674, roughness:0.95, metalness:0, flatShading:true});
  const bois=new THREE.MeshStandardMaterial({color:0x5a3e22, roughness:0.95, metalness:0, flatShading:true});
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x8a7f6a, map:pierre.map, roughnessMap:pierre.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const matTuile=new THREE.MeshStandardMaterial({color:0x7a3528, roughness:0.95, metalness:0, flatShading:true});

  // SOUBASSEMENT débordant légèrement enterré (ancrage)
  put(swap_(box(9.0, 0.35, 6.8, 0x6b6055, 0, -0.05, 0, false), matPierre));
  // PLINTHE pierre
  put(swap_(box(8.4, 0.40, 6.4, 0x8a7f6a, 0, 0.25, 0), matPierre));
  // CORPS torchis (volume CLOS — BoxGeometry est solide fermé)
  put(swap_(box(8.0, 4.0, 6.0, 0xc8a674, 0, 2.45, 0), torchis));

  // COLOMBAGE — pan de bois sur les 4 faces (poutres + croix de St-André)
  for(const sz of [-1, 1]){
    const fz=sz*3.01;
    put(swap_(box(8.0, 0.18, 0.06, 0x5a3e22, 0, 0.6, fz, false), bois));
    put(swap_(box(8.0, 0.18, 0.06, 0x5a3e22, 0, 2.6, fz, false), bois));
    put(swap_(box(8.0, 0.22, 0.06, 0x5a3e22, 0, 4.35, fz, false), bois));
    for(const cx of [-3.6, -1.2, 1.2, 3.6])
      put(swap_(box(0.16, 4.0, 0.06, 0x5a3e22, cx, 2.45, fz, false), bois));
    // un X (croix St-André) à droite et gauche du milieu
    for(const cx of [-2.4, 2.4]){
      const L=Math.hypot(2.0, 1.6);
      const d1=swap_(box(0.12, L, 0.05, 0x5a3e22, cx, 3.3, fz, false), bois);
      d1.rotation.z=Math.atan2(1.6, 2.0); put(d1);
      const d2=swap_(box(0.12, L, 0.05, 0x5a3e22, cx, 3.3, fz, false), bois);
      d2.rotation.z=-Math.atan2(1.6, 2.0); put(d2);
    }
  }
  for(const sx of [-1, 1]){
    const fx=sx*4.01;
    put(swap_(box(0.06, 0.18, 6.0, 0x5a3e22, fx, 0.6, 0, false), bois));
    put(swap_(box(0.06, 0.18, 6.0, 0x5a3e22, fx, 2.6, 0, false), bois));
    put(swap_(box(0.06, 0.22, 6.0, 0x5a3e22, fx, 4.35, 0, false), bois));
    for(const cz of [-2.4, 0, 2.4])
      put(swap_(box(0.06, 4.0, 0.16, 0x5a3e22, fx, 2.45, cz, false), bois));
  }

  // TOIT À 2 PENTES FERMÉ (pignons inclus — volume vraiment clos)
  const roof=_M6_pitchedClosed(8.6, 6.6, 1.6, matTuile, bois);
  roof.position.y=4.5; put(roof);

  // CHEMINÉE BRIQUE (sur le toit, vers l'arrière)
  const chim=new THREE.Mesh(new THREE.BoxGeometry(0.95, 3.4, 0.95), matBrique);
  chim.position.set(2.6, 5.6, -1.8); chim.castShadow=true; put(chim);
  put(swap_(box(1.15, 0.18, 1.15, 0x3a3028, 2.6, 7.40, -1.8, false), matBrique));
  // chapeau + mitron
  const pot=new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.26, 0.55, 7),
    new THREE.MeshStandardMaterial({color:0x4a3a28, flatShading:true}));
  pot.position.set(2.7, 7.78, -1.8); put(pot);
  // émetteur de fumée
  const smoke=new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 8),
    new THREE.MeshStandardMaterial({color:0x8a8275, transparent:true, opacity:0.3, flatShading:true}));
  smoke.position.set(2.7, 8.10, -1.8); smoke.userData.chimney=true; put(smoke);

  // APPENTIS (lean-to) côté droit — petit toit en pente collé au mur
  const lean=new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.16, 3.0), matTuile);
  lean.position.set(4.8, 2.2, 0); lean.rotation.z=-0.45; put(lean);
  // 2 poteaux qui le soutiennent
  put(swap_(box(0.14, 1.8, 0.14, 0x5a3e22, 5.8, 1.05, 1.2, false), bois));
  put(swap_(box(0.14, 1.8, 0.14, 0x5a3e22, 5.8, 1.05, -1.2, false), bois));
  // établi dessous
  put(swap_(box(2.2, 0.95, 1.0, 0x6b5436, 4.9, 0.475, 0, false), bois));
  // outils accrochés (3 petits boxes dépassant du mur)
  for(let i=0; i<3; i++){
    put(swap_(box(0.10, 0.35, 0.08, 0x6b5436, -3.8+i*0.5, 2.5, 3.04, false), bois));
  }

  // PORTE bois + perron de pierre
  const dr=createDoor(1.4, 2.4, 0x281f17); dr.position.set(-0.6, 0.4, 3.1); put(dr);
  put(swap_(box(2.4, 0.40, 1.4, 0x9a9183, -0.6, 0.20, 3.5, false), matPierre));

  // 2 FENÊTRES à volets (taggées zone via createWindow → M4 active)
  for(const cx of [2.0, -2.6]){
    const w=createShutterWindow(0.9, 1.0); w.position.set(cx, 2.9, 3.07); put(w);
  }
  // fenêtre côté gauche (face -X)
  const wSide=createShutterWindow(0.8, 0.9); wSide.position.set(-4.07, 2.9, 0);
  wSide.rotation.y=Math.PI/2; put(wSide);

  // MEULE devant (chèvre + roue de meunier, à plat)
  const stoneG=new THREE.Group();
  const stone=new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.24, 16),
    new THREE.MeshStandardMaterial({color:0x8a7f6a, roughness:0.95, flatShading:true}));
  stone.position.y=0.30; stoneG.add(stone);
  // axe
  const ax=new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6),
    new THREE.MeshStandardMaterial({color:0x3a2a1a, flatShading:true}));
  ax.position.y=0.80; stoneG.add(ax);
  // bras
  const arm=new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.10, 0.10), bois);
  arm.position.set(0.4, 1.1, 0); stoneG.add(arm);
  stoneG.position.set(-3.8, 0, 4.6); put(stoneG);

  // TAS DE BOIS contre le mur (existant)
  for(let i=0;i<3;i++){
    const b=new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.8, 7),
      new THREE.MeshStandardMaterial({color:0x6b513a, flatShading:true}));
    b.rotation.z=Math.PI/2;
    b.position.set(-3.6, 0.25+i*0.36, -2.2+i*0.1); put(b);
  }
}
function buildPlantStage2(g,put){           // la MANUFACTURE — brique, sheds vitrés, cour pavée, cloche
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const briqueH=briqueTexture('haut');
  const matBriqueH=new THREE.MeshStandardMaterial({
    color:0x4a2620, map:briqueH.map, roughnessMap:briqueH.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x7a7060, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  const bois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matTuile=new THREE.MeshStandardMaterial({color:0x46393b, roughness:0.95, metalness:0, flatShading:true});
  // VERRIÈRE FORGELIGHT — taggée M4 pour pulsation production
  const matVerriere=new THREE.MeshStandardMaterial({
    color:0x4a1812, emissive:new THREE.Color(COLORSCRIPT.forgeLight), emissiveIntensity:0.5,
    roughness:0.6, metalness:0.2, flatShading:true,
  });
  matVerriere.userData.m4Role='usine-verriere';
  const matFer=new THREE.MeshStandardMaterial({color:0x2a2620, roughness:0.5, metalness:0.7, flatShading:true});

  // SOUBASSEMENT + PLINTHE
  put(swap_(box(13.4, 0.40, 9.4, 0x6b6055, 0, -0.05, 0, false), matPierre));
  put(swap_(box(12.6, 0.45, 8.6, 0x8a7f6a, 0, 0.275, 0), matPierre));

  // CORPS brique (volume CLOS)
  const corps=swap_(box(12.0, 5.6, 8.0, 0x5a3026, 0, 3.30, 0), matBrique);
  put(corps);

  // PILASTRES brique (rythme vertical sur les 4 faces)
  for(const sz of [-1, 1]){
    const fz=sz*4.01;
    for(let i=0;i<5;i++){
      const cx=-4.8 + i*2.4;
      put(swap_(box(0.45, 5.6, 0.18, 0x4e2620, cx, 3.30, fz, false), matBriqueH));
    }
    // bandeau bas + haut (rappel d'assise)
    put(swap_(box(12.0, 0.30, 0.10, 0x7a5040, 0, 0.85, fz, false), matBriqueH));
    put(swap_(box(12.0, 0.40, 0.12, 0x7a5040, 0, 5.90, fz, false), matBriqueH));
  }
  for(const sx of [-1, 1]){
    const fx=sx*6.01;
    for(let i=0;i<3;i++){
      const cz=-2.8 + i*2.8;
      put(swap_(box(0.18, 5.6, 0.45, 0x4e2620, fx, 3.30, cz, false), matBriqueH));
    }
    put(swap_(box(0.10, 0.30, 8.0, 0x7a5040, fx, 0.85, 0, false), matBriqueH));
    put(swap_(box(0.12, 0.40, 8.0, 0x7a5040, fx, 5.90, 0, false), matBriqueH));
  }
  // CORNICHE en débord (encadre le haut, ferme l'œil)
  const cornicheGeo=new THREE.BoxGeometry(12.8, 0.34, 8.8);
  const corniche=new THREE.Mesh(cornicheGeo, matBriqueH);
  corniche.position.y=6.30; corniche.castShadow=true; put(corniche);

  // TOIT en SHEDS DENTÉS vitrés (verrières forgeLight) — le toit est aussi fermé
  // par un panneau plat dessous (volume non perçant depuis le dessus).
  const shed=_M6_sawtoothShed(12.4, 8.4, matTuile, matVerriere);
  shed.position.y=6.55; put(shed);

  // HORLOGE DE POINTAGE en façade (au-dessus de la porte)
  const horlogeFond=swap_(box(1.0, 1.0, 0.10, 0x6b5436, 0, 4.20, 4.05, false), bois);
  put(horlogeFond);
  const cadran=new THREE.Mesh(new THREE.CircleGeometry(0.40, 16),
    new THREE.MeshStandardMaterial({color:0xdfd5b0, emissive:0xa0824a, emissiveIntensity:0.30, flatShading:true}));
  cadran.position.set(0, 4.20, 4.11); put(cadran);
  // aiguilles
  const hA=swap_(box(0.04, 0.26, 0.02, 0x14181f, 0, 4.30, 4.12, false), matFer);
  put(hA);
  const hB=swap_(box(0.03, 0.36, 0.02, 0x14181f, 0.10, 4.25, 4.12, false), matFer);
  put(hB);

  // CLOCHE (en relief sur le toit, côté façade)
  const beffroi=new THREE.Group();
  // toiture du beffroi (pyramide ouverte sur 4 montants)
  for(let i=0;i<4;i++){
    const a=i*Math.PI/2;
    const mast=new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), matFer);
    mast.position.set(Math.cos(a)*0.45, 0.60, Math.sin(a)*0.45);
    beffroi.add(mast);
  }
  const beffroiToit=new THREE.Mesh(new THREE.ConeGeometry(0.70, 0.85, 4), matTuile);
  beffroiToit.rotation.y=Math.PI/4; beffroiToit.position.y=1.65; beffroi.add(beffroiToit);
  const cloche=new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.30, 0.42, 12),
    new THREE.MeshStandardMaterial({color:0x6b5a35, roughness:0.5, metalness:0.7, flatShading:true}));
  cloche.position.y=0.85; beffroi.add(cloche);
  beffroi.position.set(0, 7.40, 3.6);
  put(beffroi);

  // PORTES (2 grandes portes ouvrières)
  put(createDoor(1.6, 2.6, 0x281f17)).position.set(-1.8, 0.40, 4.04);
  const dr2=createDoor(1.6, 2.6, 0x281f17); dr2.position.set(1.8, 0.40, 4.04); put(dr2);
  // auvent sur les portes
  const auvent=swap_(box(4.6, 0.16, 1.6, 0x46362a, 0, 3.30, 4.65, false), bois);
  auvent.rotation.x=0.25; put(auvent);
  for(const sx of [-1, 1]){
    const sup=swap_(box(0.08, 0.10, 1.6, 0x2a2620, sx*2.2, 3.10, 4.65, false), matFer);
    sup.rotation.x=0.25; put(sup);
  }

  // FENÊTRES réparties (façade, flancs, arrière)
  for(let i=0;i<3;i++){
    const w=createShutterWindow(0.9, 1.0); w.position.set(-3.5+i*3.5, 4.40, 4.05); put(w);
  }
  for(let i=0;i<5;i++){
    const w=createWindow(0.7, 0.75); w.position.set(-4.2+i*2.1, 2.00, 4.06); put(w);
  }
  // flancs
  for(const sx of [-1, 1]){
    for(const cz of [-2.5, 0, 2.5]){
      const w=createWindow(0.7, 1.1); w.position.set(sx*6.05, 4.30, cz);
      w.rotation.y=sx>0?-Math.PI/2:Math.PI/2; put(w);
    }
  }
  // arrière (3 fenêtres + petite porte)
  for(const fx of [-3.0, 0, 3.0]){
    const w=createWindow(0.7, 1.0); w.position.set(fx, 4.30, -4.05); w.rotation.y=Math.PI; put(w);
  }
  // grande porte de service arrière
  put(swap_(box(1.8, 2.8, 0.08, 0x281f17, 0, 1.40, -4.04, false), bois));

  // CHEMINÉE BRIQUE (haute, latérale)
  const chim=new THREE.Mesh(new THREE.BoxGeometry(1.4, 9.0, 1.4), matBriqueH);
  chim.position.set(-4.5, 4.50, -3.0); chim.castShadow=true; put(chim);
  put(swap_(box(1.8, 0.22, 1.8, 0x3a3028, -4.5, 9.10, -3.0, false), matBriqueH));
  const smoke=new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8),
    new THREE.MeshStandardMaterial({color:0x8a8275, transparent:true, opacity:0.3, flatShading:true}));
  smoke.position.set(-4.5, 9.50, -3.0); smoke.userData.chimney=true; put(smoke);

  // COUR PAVÉE devant la porte (paveTexture variant 0)
  const pave=paveTexture(0);
  pave.map.repeat.set(2, 1.5); pave.roughnessMap.repeat.set(2, 1.5);
  const cour=new THREE.Mesh(new THREE.PlaneGeometry(10.0, 3.4),
    new THREE.MeshStandardMaterial({color:0x88796a, map:pave.map, roughnessMap:pave.roughnessMap, roughness:1.0, metalness:0}));
  cour.rotation.x=-Math.PI/2; cour.position.set(0, 0.02, 5.8);
  cour.receiveShadow=true; put(cour);

  // CLÔTURE basse + enseigne (existant)
  const cl=createFenceSegment(6); cl.position.set(-8, 0, 2); cl.rotation.y=Math.PI/2; put(cl);
  const sign=createPriceBoard('⚒'); sign.position.set(5.2, 0, 4.6); put(sign);
}
function buildPlantStage3(g,put){           // la GRANDE INDUSTRIE — cathédrale brique+fer
  const brique=briqueTexture('haut');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x4a2620, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const briqueSale=briqueTexture('sale');
  const matBriqueSale=new THREE.MeshStandardMaterial({
    color:0x4a2620, map:briqueSale.map, roughnessMap:briqueSale.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x6b6055, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  const tole=toleTexture();
  const matTole=new THREE.MeshStandardMaterial({
    color:0x5a564f, map:tole.map, roughnessMap:tole.roughnessMap, roughness:0.8, metalness:0.3,
  });
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matBoisFonce=new THREE.MeshStandardMaterial({color:0x2a2620, roughness:0.95, metalness:0, flatShading:true});
  // VERRIÈRES FORGELIGHT (rouges pulsantes, taggées M4)
  const matVerriere=new THREE.MeshStandardMaterial({
    color:0x4a1812, emissive:new THREE.Color(COLORSCRIPT.forgeLight), emissiveIntensity:0.8,
    roughness:0.5, metalness:0.2, flatShading:true,
  });
  matVerriere.userData.m4Role='usine-verriere';

  // SOUBASSEMENT + PLINTHE
  put(swap_(box(16.6, 0.45, 12.4, 0x4a463f, 0, -0.05, 0, false), matPierre));
  put(swap_(box(15.6, 0.60, 11.6, 0x6b6055, 0, 0.30, 0), matPierre));

  // CORPS PRINCIPAL — cathédrale brique (volume CLOS)
  put(swap_(box(15.0, 8.0, 11.0, 0x4a2620, 0, 4.60, 0), matBrique));

  // PILASTRES + bandeaux sur les 4 faces (rythme cathédrale)
  for(const sz of [-1, 1]){
    const fz=sz*5.51;
    for(let i=0;i<6;i++){
      const cx=-6.0+i*2.4;
      put(swap_(box(0.50, 8.0, 0.22, 0x3a1c18, cx, 4.60, fz, false), matBriqueSale));
    }
    // bandeau bas + médian + haut
    put(swap_(box(15.0, 0.30, 0.14, 0x7a5040, 0, 1.00, fz, false), matBriqueSale));
    put(swap_(box(15.0, 0.26, 0.14, 0x7a5040, 0, 5.00, fz, false), matBriqueSale));
    put(swap_(box(15.0, 0.40, 0.16, 0x7a5040, 0, 8.40, fz, false), matBriqueSale));
  }
  for(const sx of [-1, 1]){
    const fx=sx*7.51;
    for(let i=0;i<4;i++){
      const cz=-3.9+i*2.6;
      put(swap_(box(0.22, 8.0, 0.50, 0x3a1c18, fx, 4.60, cz, false), matBriqueSale));
    }
    put(swap_(box(0.14, 0.30, 11.0, 0x7a5040, fx, 1.00, 0, false), matBriqueSale));
    put(swap_(box(0.14, 0.40, 11.0, 0x7a5040, fx, 8.40, 0, false), matBriqueSale));
  }
  // CORNICHE en débord (encadre le toit)
  const corn=swap_(box(15.8, 0.45, 11.8, 0x2a1410, 0, 8.85, 0, false), matBriqueSale);
  corn.castShadow=true; put(corn);

  // TOIT en SHEDS DENTÉS vitrés (verrières rougeoyantes)
  const shed=_M6_sawtoothShed(14.8, 10.6, matTole, matVerriere);
  shed.position.y=9.15; put(shed);

  // AILE LATÉRALE (atelier annexe) — corps secondaire fermé
  const wingMat=matBriqueSale;
  put(swap_(box(6.0, 5.0, 8.0, 0x4a2620, 9.5, 3.10, 0), wingMat));
  // pilastres aile
  for(const sx of [-1, 1]){
    const fx=9.5 + sx*3.01;
    for(let i=0;i<3;i++){
      const cz=-3.0+i*3.0;
      put(swap_(box(0.18, 5.0, 0.45, 0x3a1c18, fx, 3.10, cz, false), matBriqueSale));
    }
  }
  for(const sz of [-1, 1]){
    const fz=sz*4.01;
    for(const cx of [7.5, 9.5, 11.5])
      put(swap_(box(0.50, 5.0, 0.18, 0x3a1c18, cx, 3.10, fz, false), matBriqueSale));
  }
  // toit aile (à 2 pentes fermé)
  const wingRoof=_M6_pitchedClosed(6.4, 8.4, 1.3, matTole, matBriqueSale);
  wingRoof.position.set(9.5, 5.6, 0); put(wingRoof);

  // 2 HAUTES CHEMINÉES
  for(const stack of [{x:-5.5, h:14.5}, {x:11.0, h:9.5}]){
    const ch=new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.10, stack.h, 16), matBriqueSale);
    ch.position.set(stack.x, stack.h/2 + 0.6, -3.5); ch.castShadow=true; put(ch);
    // chapeau
    put(swap_(box(2.5, 0.30, 2.5, 0x2a1410, stack.x, stack.h + 0.75, -3.5, false), matBriqueSale));
    // émetteur de fumée
    const smoke=new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 8),
      new THREE.MeshStandardMaterial({color:0x8a8275, transparent:true, opacity:0.3, flatShading:true}));
    smoke.position.set(stack.x, stack.h + 1.30, -3.5); smoke.userData.chimney=true; put(smoke);
  }

  // PASSERELLES MÉTALLIQUES (en hauteur, le long de la façade)
  for(const sz of [-1, 1]){
    const fz=sz*5.81;
    put(swap_(box(15.0, 0.10, 0.35, 0x1c1814, 0, 5.20, fz, false), matFer));
    // garde-corps
    put(swap_(box(15.0, 0.05, 0.04, 0x1c1814, 0, 5.55, fz - 0.18*sz, false), matFer));
    // poteaux du garde-corps
    for(let i=0;i<8;i++){
      const cx=-7.0 + i*2.0;
      put(swap_(box(0.04, 0.40, 0.04, 0x1c1814, cx, 5.40, fz - 0.16*sz, false), matFer));
    }
    // escalier en bout
    put(swap_(box(0.20, 5.0, 0.80, 0x1c1814, -7.5, 2.65, fz - 0.4*sz, false), matFer));
  }

  // TUYAUTERIES (tubes horizontaux + vertical le long du mur)
  for(const cy of [2.2, 6.0]){
    const pipe=new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 13.0, 8), matFer);
    pipe.rotation.z=Math.PI/2;
    pipe.position.set(0, cy, 5.65); put(pipe);
  }
  const vPipe=new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 6.5, 8), matFer);
  vPipe.position.set(5.5, 3.25, 5.70); put(vPipe);
  // coude
  const elbow=new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.20, 6, 8, Math.PI/2), matFer);
  elbow.position.set(5.5, 6.0, 5.70); elbow.rotation.z=Math.PI; put(elbow);

  // MONTE-CHARGE (cage métallique extérieure, côté façade)
  const liftCage=new THREE.Group();
  for(const [sx, sz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]])
    liftCage.add(swap_(box(0.10, 7.0, 0.10, 0x1c1814, sx, 3.5, sz, false), matFer));
  // plate-forme
  liftCage.add(swap_(box(1.7, 0.10, 1.7, 0x1c1814, 0, 2.5, 0, false), matFer));
  // câble vers le haut
  liftCage.add(swap_(box(0.06, 5.0, 0.06, 0x1c1814, 0, 5.5, 0, false), matFer));
  // toit cage
  liftCage.add(swap_(box(1.9, 0.18, 1.9, 0x1c1814, 0, 7.10, 0, false), matFer));
  liftCage.position.set(-7.2, 0, 6.0); put(liftCage);

  // GRANDES PORTES OUVRIÈRES (atelier — 2 grandes portes coulissantes)
  put(swap_(box(3.0, 4.0, 0.14, 0x281f17, -3.0, 2.0, 5.59, false), matBoisFonce));
  put(swap_(box(3.0, 4.0, 0.14, 0x281f17, 3.0, 2.0, 5.59, false), matBoisFonce));
  // bande horizontale renforcée
  put(swap_(box(7.0, 0.18, 0.14, 0x1c1814, 0, 2.0, 5.62, false), matFer));

  // FENÊTRES HAUTES (la lumière vient principalement des sheds)
  for(let i=0;i<5;i++){
    const w=createWindow(0.9, 1.2); w.position.set(-6+i*3, 6.5, 5.59); put(w);
  }
  // flancs + arrière
  for(const sx of [-1, 1]){
    for(const cz of [-3.0, -1.0, 1.0, 3.0]){
      const w=createWindow(0.7, 1.1); w.position.set(sx*7.55, 6.5, cz);
      w.rotation.y=sx>0?-Math.PI/2:Math.PI/2; put(w);
    }
  }
  for(const fx of [-5.0, -2.5, 0, 2.5, 5.0]){
    const w=createWindow(0.7, 1.1); w.position.set(fx, 6.5, -5.59); w.rotation.y=Math.PI; put(w);
  }

  // ENGRENAGES extérieurs (existants)
  const gA=createGear(1.4); gA.position.set(-6, 3, 5.95); put(gA);
  const gB=createGear(1.0); gB.position.set(-3.4, 2, 5.95); put(gB);
}

// helper local M6 : swap material sur le mesh retourné par box() puis renvoie le mesh.
// Object3D.add() retourne le parent, d'où la nécessité.
function swap_(m, mat){ m.material=mat; return m; }
const PLANT_BUILDERS={1:buildPlantStage1,2:buildPlantStage2,3:buildPlantStage3};

/* La zone Usine du joueur : seulement la COUR (quai, machine extérieure, enseigne P).
   Le bâtiment vient de refreshPlayerPlant, selon l'âge — comme chez les concurrents. */
function buildUsine(g){
  const dock=createDock(8,4,0.7); dock.position.set(-9,0,4); g.add(dock);
  g.add(box(2,2,3,COL.fer,-9,1,4,false));
  const sp=createSign('P'); sp.scale.set(2.2,2.2,1); sp.position.set(0,9.8,5.6); g.add(sp);
}
/* v53 — le bâtiment du joueur suit SON âge (atelier -> manufacture -> grande industrie) */
function refreshPlayerPlant(){
  const g=zoneGroups['Usine']; if(!g) return;
  clearLayer(g,'plant');
  if(!state.buildings || state.buildings.atelier<=0) return;       // terrain vide avant la fondation
  const st=Math.min(3,Math.max(1,state.age||1));
  const put=m=>{ tagLayer(m,'plant'); g.add(m); return m; };
  PLANT_BUILDERS[st](g,put);
  g._plantStage=st;
}
function buildMarche(g){              // MARCHÉ DE VENTE A' — place marchande chaleureuse, sortie du circuit
  // matières partagées
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x6b6055, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  const planches=planchesTexture();
  const matPlanches=new THREE.MeshStandardMaterial({
    color:0x7a6648, map:planches.map, roughnessMap:planches.roughnessMap,
    roughness:0.95, metalness:0,
  });
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matBoisClair=new THREE.MeshStandardMaterial({color:0x8a6940, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matToit=new THREE.MeshStandardMaterial({color:0x6b3328, roughness:0.95, metalness:0, flatShading:true});
  // TOILE OCRE des étals (chaleureuse — clé de l'ambiance « sortie du circuit »)
  const matToileA=new THREE.MeshStandardMaterial({
    color:0xc6843c, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true,
  });
  const matToileB=new THREE.MeshStandardMaterial({
    color:0xa66232, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true,
  });
  const matToileC=new THREE.MeshStandardMaterial({
    color:0xd49a52, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true,
  });

  // SOUBASSEMENT débordant (ancrage)
  g.add(_M5_box(16.0, 0.30, 16.0, matPierre, 0, -0.05, 0));

  // PLACE PAVÉE (paveTexture variant 2, claire — la place est entretenue, c'est là que l'argent circule)
  const pave=paveTexture(2);
  pave.map.repeat.set(3.2, 3.2); pave.roughnessMap.repeat.set(3.2, 3.2);
  const sol=new THREE.Mesh(new THREE.PlaneGeometry(15.0, 15.0),
    new THREE.MeshStandardMaterial({color:0xa89878, map:pave.map, roughnessMap:pave.roughnessMap, roughness:1.0, metalness:0}));
  sol.rotation.x=-Math.PI/2; sol.position.set(0, 0.15, 0); sol.receiveShadow=true;
  g.add(sol);

  // MUR BAS périphérique sur 3 côtés (encadre la place, ouvert au sud côté rue)
  const matMuret=new THREE.MeshStandardMaterial({color:0x8a7f6a, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0});
  // mur nord
  g.add(_M5_box(15.4, 1.0, 0.35, matMuret, 0, 0.60, -7.55));
  // muret est + ouest (avec ouverture au centre)
  for(const sx of [-1, 1]){
    g.add(_M5_box(0.35, 1.0, 5.0, matMuret, sx*7.55, 0.60, -3.5));
    g.add(_M5_box(0.35, 1.0, 5.0, matMuret, sx*7.55, 0.60,  3.5));
  }
  // couronnement (chapeau pierre du muret)
  g.add(_M5_box(15.6, 0.10, 0.50, matPierre, 0, 1.15, -7.55, false));
  for(const sx of [-1, 1]){
    g.add(_M5_box(0.50, 0.10, 5.2, matPierre, sx*7.55, 1.15, -3.5, false));
    g.add(_M5_box(0.50, 0.10, 5.2, matPierre, sx*7.55, 1.15,  3.5, false));
  }
  // bornes pierre aux ouvertures sud (entrée principale)
  for(const sx of [-1, 1]){
    const borne=new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.36, 1.10, 8), matPierre);
    borne.position.set(sx*6.0, 0.55, 7.55); g.add(borne);
  }

  // BUREAU DE PERCEPTION (volume CLOS — petit bâtiment central nord)
  // empreinte 4×3, soubassement + plinthe + corps brique + corniche + toit pitched fermé
  const bcx=0, bcz=-5.5;
  g.add(_M5_box(4.6, 0.30, 3.6, matPierre, bcx, 0.15, bcz));        // soubassement
  g.add(_M5_box(4.2, 0.40, 3.2, matPierre, bcx, 0.50, bcz));        // plinthe
  g.add(_M5_box(4.0, 3.0, 3.0, matBrique, bcx, 2.20, bcz));         // corps brique
  g.add(_M5_box(4.3, 0.20, 3.3, matPierre, bcx, 3.80, bcz, false)); // corniche
  // toit pitched FERMÉ (pignons inclus)
  const bRoof=_M6_pitchedClosed(4.4, 3.4, 1.0, matToit, matBrique);
  bRoof.position.set(bcx, 3.90, bcz); g.add(bRoof);
  // cheminée
  g.add(_M5_box(0.40, 0.95, 0.40, matBrique, bcx + 1.4, 4.45, bcz - 0.7));
  g.add(_M5_box(0.50, 0.10, 0.50, matPierre, bcx + 1.4, 4.97, bcz - 0.7, false));
  // GUICHET saillant côté sud (face à la place — c'est là qu'on encaisse)
  g.add(_M5_box(1.8, 1.6, 0.50, matBois, bcx, 1.30, bcz + 1.65));
  g.add(_M5_box(2.0, 0.10, 0.60, matPierre, bcx, 2.10, bcz + 1.65));
  // grille du guichet (5 barreaux fins)
  for(let i=0; i<5; i++){
    g.add(_M5_box(0.03, 0.5, 0.03, matFer, bcx - 0.6 + i*0.3, 2.45, bcz + 1.68));
  }
  // FENÊTRES (1 par face — taggées zone via createWindow → M4 vert pâle / cold pour A')
  const wFront=createWindow(0.7, 0.95); wFront.position.set(bcx, 2.85, bcz + 1.54); g.add(wFront);
  for(const sx of [-1, 1]){
    const w=createWindow(0.55, 0.85); w.position.set(bcx + sx*2.04, 2.50, bcz);
    w.rotation.y = sx>0 ? -Math.PI/2 : Math.PI/2; g.add(w);
  }
  const wBack=createWindow(0.55, 0.85); wBack.position.set(bcx, 2.50, bcz - 1.54); wBack.rotation.y=Math.PI; g.add(wBack);
  // enseigne £ sur le bureau (la VALEUR se réalise ici)
  const sLab=createSign('£'); sLab.scale.set(1.4, 1.4, 1); sLab.position.set(bcx, 3.40, bcz + 1.55); g.add(sLab);

  // ÉTALS COUVERTS (6 étals organisés en deux rangées, sous toiles ocre)
  // chaque étal : table en planches + 4 poteaux + toile inclinée + bandeau festonné
  const stallLayouts=[
    {x:-5, z:-1.5, color:matToileA, goods:'caisses'},
    {x: 0, z:-1.5, color:matToileC, goods:'sacs'},
    {x: 5, z:-1.5, color:matToileB, goods:'tonneaux'},
    {x:-5, z: 3.5, color:matToileC, goods:'sacs'},
    {x: 0, z: 3.5, color:matToileA, goods:'caisses'},
    {x: 5, z: 3.5, color:matToileB, goods:'tonneaux'},
  ];
  for(const sl of stallLayouts){
    const stallG=new THREE.Group();
    stallG.position.set(sl.x, 0.15, sl.z);
    // 4 poteaux
    for(const [px, pz] of [[-1.3, -0.9], [1.3, -0.9], [-1.3, 0.9], [1.3, 0.9]]){
      const post=_M5_box(0.10, 2.0, 0.10, matBois, px, 1.00, pz);
      stallG.add(post);
    }
    // table en planches
    stallG.add(_M5_box(2.8, 0.22, 1.8, matPlanches, 0, 1.10, 0));
    // toile inclinée (BoxGeometry mince inclinée)
    const toile=_M5_box(3.0, 0.04, 2.0, sl.color, 0, 2.10, 0, false);
    toile.rotation.x=0.18;
    stallG.add(toile);
    // bandeau festonné (sous le bord avant)
    const festoon=_M5_box(3.0, 0.18, 0.04, sl.color, 0, 1.92, 1.0, false);
    stallG.add(festoon);
    // marchandises sur la table
    if(sl.goods === 'caisses'){
      for(let i=0; i<3; i++){
        const cw=0.55, ch=0.40;
        stallG.add(_M5_box(cw, ch, cw, matBoisClair, -0.8 + i*0.8, 1.42, 0, false));
      }
    } else if(sl.goods === 'sacs'){
      for(let i=0; i<4; i++){
        const sack=new THREE.Mesh(new THREE.SphereGeometry(0.30, 8, 6),
          new THREE.MeshStandardMaterial({color:0xc9b78c, roughness:0.95, flatShading:true}));
        sack.scale.set(1.0, 0.85, 1.0);
        sack.position.set(-0.9 + i*0.6, 1.45, 0); stallG.add(sack);
      }
    } else { // tonneaux
      for(let i=0; i<3; i++){
        const barrel=new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.55, 10),
          new THREE.MeshStandardMaterial({color:0x6b4a2c, roughness:0.95, flatShading:true}));
        barrel.position.set(-0.7 + i*0.7, 1.50, 0); stallG.add(barrel);
        // cerclage
        for(const by of [-0.18, 0.18]){
          const band=new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.06, 10),
            new THREE.MeshStandardMaterial({color:0x2c2113, roughness:0.95, flatShading:true}));
          band.position.set(-0.7 + i*0.7, 1.50 + by, 0); stallG.add(band);
        }
      }
    }
    g.add(stallG);
  }

  // 4 LANTERNES À GAZ aux coins de la place (ambiance dorée chaleureuse, sortie du circuit)
  // Réutilise createBronzeLantern (faux halos M4, sans PointLight neuve).
  for(const [lx, lz] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]]){
    const lant=createBronzeLantern();
    lant.position.set(lx, 0.15, lz);
    lant.scale.setScalar(0.78);
    g.add(lant);
  }

  // MARCHANDISES EMPILÉES sur la place (tonneaux + caisses + balle)
  // empilement nord-est
  for(let i=0; i<3; i++){
    const c=createCrate(1.1, i%2?0x8a6b49:0x9a7a55);
    c.position.set(6.5, 0.15, -2 + i*0.3);
    g.add(c);
  }
  // tas de sacs nord-ouest
  for(let i=0; i<3; i++){
    const s=createSack(i%2 ? 0xc9b78c : 0xbfa97e);
    s.position.set(-6.5, 0.15, -2 + i*0.7); g.add(s);
  }
  // tonneaux empilés sud-ouest
  const barrelA=createBarrel(0x6b4a2c); barrelA.position.set(-6.2, 0.15, 6.0); g.add(barrelA);
  const barrelB=createBarrel(0x6b4a2c); barrelB.position.set(-5.0, 0.15, 6.0); g.add(barrelB);
  // panneau de prix £
  const pb1=createPriceBoard('£'); pb1.position.set(-6.0, 0.15, 6.8); g.add(pb1);
  const pb2=createPriceBoard('£'); pb2.position.set(6.0, 0.15, 6.8); pb2.rotation.y=0.3; g.add(pb2);

  // ENSEIGNE A' au-dessus du bureau (le moment où la valeur se réalise)
  const sp=createSign("A'"); sp.scale.set(2.6, 1.7, 1); sp.position.set(0, 6.2, -5.5); g.add(sp);
}
function buildEntrepot(g){            // ENTREPÔT — longue halle à arches numérotées, quai de chargement
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const briqueH=briqueTexture('haut');
  const matBriqueH=new THREE.MeshStandardMaterial({
    color:0x4a2620, map:briqueH.map, roughnessMap:briqueH.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x6b6055, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  const planches=planchesTexture();
  const matPlanches=new THREE.MeshStandardMaterial({
    color:0x7a6648, map:planches.map, roughnessMap:planches.roughnessMap,
    roughness:0.95, metalness:0,
  });
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matTuile=new THREE.MeshStandardMaterial({color:0x3a2a20, roughness:0.95, metalness:0, flatShading:true});

  // SOUBASSEMENT + PLINTHE
  g.add(_M5_box(16.4, 0.45, 11.6, matPierre, 0, -0.05, 0));
  g.add(_M5_box(15.6, 0.55, 10.8, matPierre, 0, 0.275, 0));

  // CORPS — longue halle brique (volume CLOS)
  g.add(_M5_box(15.0, 7.4, 10.4, matBrique, 0, 4.25, 0));

  // PILASTRES + bandeaux (rythme régulier — séparateurs des arches)
  // 6 pilastres en façade, 4 en arrière, 3 par flanc
  for(const sz of [-1, 1]){
    const fz=sz*5.21;
    for(let i=0; i<6; i++){
      const cx=-6.25 + i*2.5;
      g.add(_M5_box(0.4, 7.4, 0.18, matBriqueH, cx, 4.25, fz));
    }
    // bandeau bas + haut
    g.add(_M5_box(15.0, 0.30, 0.10, matBriqueH, 0, 0.85, fz));
    g.add(_M5_box(15.0, 0.38, 0.12, matBriqueH, 0, 7.65, fz));
  }
  for(const sx of [-1, 1]){
    const fx=sx*7.51;
    for(let i=0; i<3; i++){
      const cz=-3.5 + i*3.5;
      g.add(_M5_box(0.18, 7.4, 0.45, matBriqueH, fx, 4.25, cz));
    }
    g.add(_M5_box(0.10, 0.30, 10.4, matBriqueH, fx, 0.85, 0));
    g.add(_M5_box(0.12, 0.38, 10.4, matBriqueH, fx, 7.65, 0));
  }
  // CORNICHE
  const corn=_M5_box(15.4, 0.40, 10.8, matBriqueH, 0, 8.05, 0);
  corn.castShadow=true; g.add(corn);

  // TOIT À 2 PENTES FERMÉ
  const roof=_M6_pitchedClosed(15.6, 11.0, 1.8, matTuile, matBriqueH);
  roof.position.y=8.25; g.add(roof);

  // ARCHES NUMÉROTÉES en façade (5 arches semi-circulaires)
  // chaque arche : 1 portail rectangulaire surmonté d'un demi-disque
  for(let i=0; i<5; i++){
    const cx=-5.0 + i*2.5;
    // portail (porte coulissante en planches)
    const door=_M5_box(1.8, 3.6, 0.10, matPlanches, cx, 1.80, 5.18);
    door.userData.archNumber=i+1;
    g.add(door);
    // 5 lattes horizontales en relief
    for(let k=0; k<5; k++){
      g.add(_M5_box(1.7, 0.06, 0.12, matBois, cx, 0.55 + k*0.65, 5.24, false));
    }
    // arc cintré au-dessus (demi-torus)
    const arc=new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.10, 4, 16, Math.PI),
      matBriqueH);
    arc.position.set(cx, 3.65, 5.20);
    arc.rotation.z=0;
    g.add(arc);
    // clé de voûte
    g.add(_M5_box(0.20, 0.30, 0.16, matPierre, cx, 4.55, 5.22, false));
    // numéro peint au-dessus de chaque arche (canvas mini)
    const num=createSign(String(i+1));
    num.scale.set(0.9, 0.9, 1);
    num.position.set(cx, 5.30, 5.30);
    g.add(num);
  }

  // FENÊTRES HAUTES (au-dessus des arches)
  for(let i=0; i<5; i++){
    const cx=-5.0 + i*2.5;
    const w=createWindow(0.7, 0.85); w.position.set(cx, 6.50, 5.22); g.add(w);
  }
  // flancs
  for(const sx of [-1, 1]){
    for(const cz of [-3.0, -1.0, 1.0, 3.0]){
      const w=createWindow(0.7, 1.0); w.position.set(sx*7.55, 5.50, cz);
      w.rotation.y = sx>0 ? -Math.PI/2 : Math.PI/2;
      g.add(w);
    }
  }
  // arrière : 4 fenêtres + porte de service
  for(const fx of [-4.5, -1.5, 1.5, 4.5]){
    const w=createWindow(0.7, 1.1); w.position.set(fx, 5.50, -5.22); w.rotation.y=Math.PI;
    g.add(w);
  }
  // porte arrière
  g.add(_M5_box(2.0, 3.0, 0.10, matBois, 0, 1.50, -5.22));

  // AUVENT au-dessus du quai (devant les arches)
  const auvent=_M5_box(13.0, 0.18, 2.2, matBois, 0, 4.40, 6.50, false);
  auvent.rotation.x=0.25; g.add(auvent);
  for(const sx of [-1, 1]){
    const sup=_M5_box(0.10, 0.10, 2.2, matFer, sx*6.0, 4.20, 6.50, false);
    sup.rotation.x=0.25; g.add(sup);
  }

  // QUAI DE CHARGEMENT en planches (devant les arches)
  const dock=_M5_box(14.0, 0.55, 3.4, matPlanches, 0, 0.275, 7.5);
  dock.receiveShadow=true; g.add(dock);
  // poteaux soutiens du quai
  for(const sx of [-1, 0, 1]){
    g.add(_M5_box(0.30, 0.50, 0.30, matBois, sx*5.0, 0.25, 9.0));
  }

  // PILES DE CAISSES instanciées le long du quai (InstancedMesh)
  const crateGeo=new THREE.BoxGeometry(1.0, 0.9, 1.0);
  const crateMat=new THREE.MeshStandardMaterial({color:0x8a5a3e, map:texWood(), roughness:0.95, metalness:0});
  // bandes en relief
  const N=14;
  const crates=new THREE.InstancedMesh(crateGeo, crateMat, N);
  const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion(), S=new THREE.Vector3(1,1,1);
  let idx=0;
  // 2 piles de 3 + colonnes éparses
  const positions=[
    // pile gauche (2 niveaux × 2)
    [-6.0, 1.00, 7.0],[-6.0, 1.00, 8.0],[-6.0, 1.90, 7.5],
    // pile centre
    [-1.5, 1.00, 7.0],[-0.4, 1.00, 7.0],[-1.5, 1.90, 7.0],
    // pile droite
    [5.0, 1.00, 7.0],[5.0, 1.00, 8.0],[5.0, 1.90, 7.5], [6.1, 1.00, 7.5],
    // caisses isolées sur le quai
    [-3.5, 1.00, 8.5],[3.0, 1.00, 8.5],[2.0, 1.00, 7.5],[-2.5, 1.00, 8.0],
  ];
  for(const [x, y, z] of positions){
    const rot=(idx*37) % 360 * (Math.PI/180);
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), rot);
    P.set(x, y, z);
    M.compose(P, Q, S); crates.setMatrixAt(idx, M);
    idx++;
  }
  crates.count=Math.min(N, idx);
  crates.instanceMatrix.needsUpdate=true;
  crates.castShadow=true; crates.receiveShadow=true;
  g.add(crates);

  // QUELQUES TONNEAUX éparpillés (créés directement, pas instanciés — moins nombreux)
  for(let i=0; i<4; i++){
    const barrel=createBarrel(0x6b4a2c);
    barrel.position.set(-7 + i*4.5, 0.55, 9.2);
    g.add(barrel);
  }

  // ENSEIGNE M'
  const sp=createSign("M'"); sp.scale.set(2.4, 1.6, 1); sp.position.set(0, 8.50, 5.40); g.add(sp);
}
/* =====================================================================
   M6 Lot C — créations spécifiques au quartier ouvrier.
   createTenementHouse : maison serrée 2-3 niveaux. Volume CLOS, enduit
   décrépit laissant voir la brique par plaques (texture 'decrep'),
   volets dépareillés, fenêtres taggées (M4 : ~25% allumées).
   ===================================================================== */
function createTenementHouse(width=3.0, height=6.0, depth=3.2, tone=0x3d4a5c){
  const g=new THREE.Group();
  // matières — brique décrépie (laisse voir l'enduit + brique)
  const brique=briqueTexture('decrep');
  const matEnduit=new THREE.MeshStandardMaterial({
    color:tone, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const matToit=new THREE.MeshStandardMaterial({color:0x3a2a20, roughness:0.95, metalness:0, flatShading:true});
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matCharbon=new THREE.MeshStandardMaterial({color:0x2a241d, roughness:0.95, metalness:0, flatShading:true});
  const matVolet=new THREE.MeshStandardMaterial({color:0x5a4530, roughness:0.95, metalness:0, flatShading:true});
  // SOUBASSEMENT (ancrage)
  g.add(_M5_box(width+0.30, 0.30, depth+0.30, matCharbon, 0, -0.05, 0));
  // PLINTHE basse
  g.add(_M5_box(width+0.15, 0.30, depth+0.15, matCharbon, 0, 0.15, 0));
  // CORPS (volume CLOS)
  g.add(_M5_box(width, height, depth, tone, 0, 0.30 + height/2, 0)).material=matEnduit;
  // BANDEAU médian (rappel d'étage)
  g.add(_M5_box(width+0.06, 0.12, depth+0.06, matCharbon, 0, 0.30 + height*0.45, 0));
  // CORNICHE
  g.add(_M5_box(width+0.20, 0.18, depth+0.20, matCharbon, 0, 0.30 + height + 0.09, 0));
  // TOIT pitched fermé (pignons inclus)
  const roof=_M6_pitchedClosed(width+0.4, depth+0.4, 0.8, matToit, matEnduit);
  roof.position.y=0.30 + height + 0.18; g.add(roof);
  // CHEMINÉE brique
  g.add(_M5_box(0.45, 1.3, 0.45, matCharbon, width*0.30, 0.30 + height + 0.65, -depth*0.20));
  g.add(_M5_box(0.55, 0.10, 0.55, matCharbon, width*0.30, 0.30 + height + 1.30, -depth*0.20, false));
  // FENÊTRES + volets dépareillés (2-3 niveaux). Tagged via createWindow (M4).
  const levels = Math.floor(height / 1.8);
  for(let lvl=0; lvl<levels; lvl++){
    const wy = 0.30 + 1.0 + lvl*1.8;
    // 2 fenêtres par étage (façade +Z)
    for(let i=0; i<2; i++){
      const wx=-width*0.25 + i*(width*0.5);
      const w=createWindow(0.50, 0.7);
      w.position.set(wx, wy, depth/2 + 0.04);
      g.add(w);
      // 1-2 volets dépareillés (pas toujours pairs)
      const has1 = ((lvl+i) % 3) !== 0;
      const has2 = ((lvl*i+i) % 4) !== 0;
      if(has1){
        const vL=_M5_box(0.22, 0.78, 0.05, matVolet, wx - 0.40, wy, depth/2 + 0.05, false);
        vL.rotation.y=-0.25; g.add(vL);
      }
      if(has2){
        const vR=_M5_box(0.22, 0.78, 0.05, matVolet, wx + 0.40, wy, depth/2 + 0.05, false);
        vR.rotation.y=0.25; g.add(vR);
      }
    }
    // 1 fenêtre par étage (face arrière)
    const wb=createWindow(0.45, 0.65);
    wb.position.set(0, wy, -depth/2 - 0.04); wb.rotation.y=Math.PI;
    g.add(wb);
    // fenêtres latérales (1 par étage par côté)
    for(const sx of [-1, 1]){
      if((lvl + sx) % 2 === 0){
        const wL=createWindow(0.40, 0.6);
        wL.position.set(sx*(width/2 + 0.04), wy, 0);
        wL.rotation.y = sx>0 ? -Math.PI/2 : Math.PI/2;
        g.add(wL);
      }
    }
  }
  // PORTE rdc (côté +Z) + seuil
  const dr=_M5_box(0.7, 1.5, 0.06, matBois, 0, 0.30 + 0.85, depth/2 + 0.03);
  g.add(dr);
  g.add(_M5_box(0.9, 0.10, 0.20, matCharbon, 0, 0.35, depth/2 + 0.12, false));
  // décrépitude : 1-2 plaques sombres sur les murs (humidité)
  for(const sx of [-1, 1]){
    const mark=new THREE.Mesh(new THREE.PlaneGeometry(width*0.35, 0.55),
      new THREE.MeshBasicMaterial({color:0x18141a, transparent:true, opacity:0.30, depthWrite:false}));
    mark.position.set(sx*width*0.18, 0.55, depth/2 + 0.045);
    g.add(mark);
  }
  return g;
}
function createLaundryLine(len=3.5, height=3.8){
  const g=new THREE.Group();
  const matCorde=new THREE.MeshStandardMaterial({color:0x2a241d, roughness:0.95, metalness:0});
  const cols=[0xc8b878, 0x8a3b2a, 0x4d5f70, 0xb89758, 0x6b513a];
  // corde
  g.add(_M5_box(0.04, 0.04, len, matCorde, 0, height, 0, false));
  // 4-5 linges suspendus (planches transparentes)
  const N=4;
  for(let i=0; i<N; i++){
    const cz=-len/2 + 0.6 + i*((len-1.2)/(N-1));
    const ch=0.7 + Math.random()*0.4;
    const cl=cols[(i*3) % cols.length];
    const cloth=new THREE.Mesh(new THREE.PlaneGeometry(0.55, ch),
      new THREE.MeshStandardMaterial({color:cl, side:THREE.DoubleSide, roughness:0.95, flatShading:true}));
    cloth.position.set(0, height - 0.05 - ch/2, cz);
    cloth.rotation.y=Math.PI/2;
    g.add(cloth);
  }
  return g;
}

/* =====================================================================
   M-QUARTIER — QUARTIER OUVRIER EXTENSIBLE.
   Le quartier n'est plus un bâtiment unique : c'est un SYSTÈME urbain
   qui s'étend et se densifie avec l'accumulation du capital.
   Sens : la prolétarisation rendue spatiale.

   Architecture :
   - 4 gabarits de maisons (taille + tonalité + hauteur). Chaque gabarit
     a 3 InstancedMesh (corps, plinthe, toit) avec count = slots de ce
     gabarit dont level ≤ quartierLevel.
   - Doors, chimneys, fenêtres (lit + dark) en InstancedMesh partagés.
   - Détails (linge, pavé, lampadaires, pompe) en Group avec level seuil.
   - quartierLevel ∈ [0,5] dérivé de la simulation (profitCumule, cycle,
     niveauVille) : niveau 0 = 3 masures éparses, niveau 5 = trame
     dense de ruelles mitoyennes.
   - updateQuartier(dt) ne fait QUE des écritures de .count et .visible.
     ZÉRO allocation par frame.
   ===================================================================== */
const Quartier = {
  built:false, level:-1,
  bodyIM:[], plinthIM:[], roofIM:[],        // [variant] → InstancedMesh
  doorIM:null, chimIM:null,
  winLitIM:null, winDarkIM:null,
  litMat:null,                              // material des fenêtres allumées (pour DayCycle gating)
  details:[],                               // [{ obj, level }]
  anchorObj:null,                           // maison principale (ancre d'interaction)
  perVariantCountByLevel:[],
  totalCountByLevel:[],
  doorCountByLevel:[], chimCountByLevel:[],
  winLitCountByLevel:[], winDarkCountByLevel:[],
};
function _M_Q_layout(){
  // Retourne la liste des SLOTS (positions + variant + level seuil),
  // triée par level ASC pour que setCount progressif révèle les premiers.
  // Emprise locale (zone Group à world (0, 62)) : x ∈ [-22, 22], z ∈ [-22, 28].
  const slots=[];
  // Helper d'ajout
  const add=(x, z, rot, variant, level)=>slots.push({x, z, rot, variant, level});

  // ====== LEVEL 0 — 3 masures éparses (le hameau d'origine) ======
  add(-4, -2, 0.20, 0, 0);
  add(3, 3, -0.10, 3, 0);
  add(-7, 6, 0.05, 1, 0);

  // ====== LEVEL 1 — ruelle principale nord-sud (alley centre), 8 maisons ======
  // ruelle au centre x=0. Rangée ouest x=-3.5 face EST. Rangée est x=+3.5 face OUEST.
  for(let i=0;i<4;i++){
    const z=-7 + i*3.2;
    add(-3.5, z, Math.PI/2,     (i%4),       1);   // face vers +X (alley)
    add( 3.5, z, -Math.PI/2,    ((i+2)%4),   1);   // face vers -X
  }

  // ====== LEVEL 2 — ruelle ouest x=-12, 6 maisons ======
  for(let i=0;i<3;i++){
    const z=-6 + i*3.4;
    add(-15.5, z, Math.PI/2,    ((i+1)%4),   2);
    add(-8.5,  z, -Math.PI/2,   ((i+3)%4),   2);
  }

  // ====== LEVEL 3 — ruelle est x=+12, 6 maisons ======
  for(let i=0;i<3;i++){
    const z=-6 + i*3.4;
    add( 8.5,  z, Math.PI/2,    ((i+2)%4),   3);
    add( 15.5, z, -Math.PI/2,   ((i+1)%4),   3);
  }

  // ====== LEVEL 4 — extension SUD de la ruelle centrale, 6 maisons ======
  for(let i=0;i<3;i++){
    const z=8 + i*3.2;
    add(-3.5, z, Math.PI/2,     ((i+1)%4), 4);
    add( 3.5, z, -Math.PI/2,    ((i+3)%4), 4);
  }

  // ====== LEVEL 5 — bloc final SE + ruelle perpendiculaire, 6 maisons ======
  for(let i=0;i<3;i++){
    const z=18 + i*3.2;
    add(-3.5, z, Math.PI/2,     ((i+2)%4), 5);
    add( 3.5, z, -Math.PI/2,    ((i+1)%4), 5);
  }

  // Tri par level ASC (essentiel pour InstancedMesh.count progressif).
  slots.sort((a,b)=>a.level - b.level);
  return slots;
}
function _M_Q_pitchedRoofGeo(w, d, rise){
  // Toit en bâtière fermé construit à la main en UN SEUL BufferGeometry
  // pour pouvoir l'instancier. Forme de "tente" :
  //   6 sommets : 4 angles bas (rectangle) + 2 sommets de faîtage (ligne).
  //   Faces : 2 pans inclinés + 2 pignons triangulaires.
  // mergeGeometries refuse BoxGeometry+ExtrudeGeometry (attributs UV
  // incompatibles), d'où cette construction manuelle.
  const W=w/2, D=d/2;
  const verts=[
    // 0: BBL (bottom-back-left, -X, y=0, -Z)
    -W, 0, -D,
    // 1: BBR (+X, -Z)
     W, 0, -D,
    // 2: BFR (+X, +Z)
     W, 0,  D,
    // 3: BFL (-X, +Z)
    -W, 0,  D,
    // 4: RB (ridge-back)
     0, rise, -D,
    // 5: RF (ridge-front)
     0, rise,  D,
  ];
  // UV plaqués naïvement (pas de tuilage critique pour un toit foncé)
  const uvs=[
    0, 0,   1, 0,   1, 1,   0, 1,
    0.5, 1, 0.5, 1,
  ];
  const indices=[
    // pan ouest (sommets 0, 3, 5, 4) — 2 triangles, winding CCW vue dessus
    0, 3, 5,   0, 5, 4,
    // pan est (sommets 1, 4, 5, 2)
    1, 4, 5,   1, 5, 2,
    // pignon arrière (0, 1, 4) — face -Z
    0, 4, 1,
    // pignon avant (3, 2, 5) — face +Z
    3, 5, 2,
  ];
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
function buildQuartierSystem(g){
  if(Quartier.built) return;
  Quartier.built=true;

  // ----- matériaux partagés -----
  const brique=briqueTexture('decrep');
  const VARIANTS=[
    { w:2.4, h:4.2, d:2.8, tone:0x3d4a5c },   // basse étroite
    { w:2.6, h:5.0, d:3.0, tone:0x344151 },   // standard
    { w:2.8, h:5.8, d:3.2, tone:0x4a5462 },   // haute
    { w:3.0, h:4.6, d:3.4, tone:0x3a4654 },   // large basse
  ];
  const matToit=new THREE.MeshStandardMaterial({color:0x3a2a20, roughness:0.95, metalness:0, flatShading:true});
  const matPlinthe=new THREE.MeshStandardMaterial({color:0x2a241d, roughness:0.95, metalness:0, flatShading:true});
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x14181f, roughness:0.5, metalness:0.7, flatShading:true});
  const matBrique=new THREE.MeshStandardMaterial({color:0x4a2620, map:brique.map, roughnessMap:brique.roughnessMap, roughness:1.0, metalness:0});

  // ----- layout & buckets par gabarit -----
  const slots=_M_Q_layout();
  const byVariant=[[],[],[],[]];
  for(const s of slots) byVariant[s.variant].push(s);
  // Tri intra-variant par level ASC pour pouvoir révéler progressivement
  // via .count = perVariantCountByLevel[v][lvl].
  for(const arr of byVariant) arr.sort((a,b)=>a.level - b.level);

  const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion(), S=new THREE.Vector3(1,1,1);

  // ----- pour chaque gabarit : corps, plinthe, toit en InstancedMesh -----
  for(let v=0; v<VARIANTS.length; v++){
    const cfg=VARIANTS[v];
    const list=byVariant[v];
    if(!list.length){ Quartier.bodyIM[v]=null; Quartier.plinthIM[v]=null; Quartier.roofIM[v]=null; continue; }

    // CORPS — brique décrépie, tonalité par variant
    const bodyMat=new THREE.MeshStandardMaterial({
      color:cfg.tone, map:brique.map, roughnessMap:brique.roughnessMap,
      roughness:1.0, metalness:0,
    });
    const bodyGeo=new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d);
    const body=new THREE.InstancedMesh(bodyGeo, bodyMat, list.length);
    body.castShadow=true; body.receiveShadow=true;
    list.forEach((s,i)=>{
      Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
      P.set(s.x, cfg.h/2 + 0.30, s.z);
      M.compose(P, Q, S); body.setMatrixAt(i, M);
    });
    body.instanceMatrix.needsUpdate=true;
    body.userData.maxCount=list.length;
    g.add(body); Quartier.bodyIM[v]=body;

    // PLINTHE débordante
    const plinthGeo=new THREE.BoxGeometry(cfg.w+0.20, 0.40, cfg.d+0.20);
    const plinth=new THREE.InstancedMesh(plinthGeo, matPlinthe, list.length);
    plinth.castShadow=true; plinth.receiveShadow=true;
    list.forEach((s,i)=>{
      Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
      P.set(s.x, 0.20, s.z);
      M.compose(P, Q, S); plinth.setMatrixAt(i, M);
    });
    plinth.instanceMatrix.needsUpdate=true;
    g.add(plinth); Quartier.plinthIM[v]=plinth;

    // TOIT pitched fermé (geometrie pré-mergée)
    const roofGeo=_M_Q_pitchedRoofGeo(cfg.w+0.4, cfg.d+0.4, 0.8);
    const roof=new THREE.InstancedMesh(roofGeo, matToit, list.length);
    roof.castShadow=true; roof.receiveShadow=true;
    list.forEach((s,i)=>{
      Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
      P.set(s.x, cfg.h + 0.30, s.z);
      M.compose(P, Q, S); roof.setMatrixAt(i, M);
    });
    roof.instanceMatrix.needsUpdate=true;
    g.add(roof); Quartier.roofIM[v]=roof;
  }

  // ----- PORTES (geometrie partagée), 1 par slot, placée au pied face avant -----
  const doorGeo=new THREE.BoxGeometry(0.70, 1.50, 0.08);
  const door=new THREE.InstancedMesh(doorGeo, matBois, slots.length);
  door.castShadow=false; door.receiveShadow=true;
  slots.forEach((s,i)=>{
    const cfg=VARIANTS[s.variant];
    // face avant = +Z LOCAL avant rotation. Décalée à d/2 - 0.05.
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
    const localFront=new THREE.Vector3(0, 0.85, cfg.d/2 + 0.05);
    localFront.applyQuaternion(Q);
    P.set(s.x + localFront.x, 0.30 + 0.75, s.z + localFront.z);
    M.compose(P, Q, S); door.setMatrixAt(i, M);
  });
  door.instanceMatrix.needsUpdate=true;
  g.add(door); Quartier.doorIM=door;

  // ----- CHEMINÉES (geometrie partagée) -----
  const chimGeo=new THREE.BoxGeometry(0.45, 1.20, 0.45);
  const chim=new THREE.InstancedMesh(chimGeo, matBrique, slots.length);
  chim.castShadow=true; chim.receiveShadow=true;
  slots.forEach((s,i)=>{
    const cfg=VARIANTS[s.variant];
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
    const localOffset=new THREE.Vector3(cfg.w*0.30, cfg.h + 0.30 + 0.95, -cfg.d*0.20);
    localOffset.applyQuaternion(Q);
    P.set(s.x + localOffset.x, localOffset.y, s.z + localOffset.z);
    M.compose(P, Q, S); chim.setMatrixAt(i, M);
  });
  chim.instanceMatrix.needsUpdate=true;
  g.add(chim); Quartier.chimIM=chim;

  // ----- FENÊTRES ALLUMÉES (M4 — gasLight) — 2 par maison face avant -----
  //   Material partagé, emissiveIntensity pilotée par updateQuartier
  //   (gating night × densité ; pas de M4 windowPanes individuels).
  Quartier.litMat=new THREE.MeshStandardMaterial({
    color:0x33414c, emissive:new THREE.Color(COLORSCRIPT.gasLight),
    emissiveIntensity:0.0, roughness:0.7, metalness:0, flatShading:true,
  });
  const winGeo=new THREE.BoxGeometry(0.50, 0.65, 0.05);
  // Une fenêtre allumée par slot, face avant étage haut.
  const winLit=new THREE.InstancedMesh(winGeo, Quartier.litMat, slots.length);
  winLit.castShadow=false; winLit.receiveShadow=false;
  slots.forEach((s,i)=>{
    const cfg=VARIANTS[s.variant];
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
    // étage haut, légèrement décalée à gauche
    const localOffset=new THREE.Vector3(-cfg.w*0.20, 0.30 + cfg.h*0.65, cfg.d/2 + 0.04);
    localOffset.applyQuaternion(Q);
    P.set(s.x + localOffset.x, localOffset.y, s.z + localOffset.z);
    M.compose(P, Q, S); winLit.setMatrixAt(i, M);
  });
  winLit.instanceMatrix.needsUpdate=true;
  g.add(winLit); Quartier.winLitIM=winLit;

  // ----- FENÊTRES SOMBRES (3 par maison : 1 front rdc + 1 arrière + 1 côté) -----
  const matWinDark=new THREE.MeshStandardMaterial({
    color:0x12161c, roughness:0.7, metalness:0.1, flatShading:true,
  });
  const winDarkCount=slots.length * 3;
  const winDark=new THREE.InstancedMesh(winGeo, matWinDark, winDarkCount);
  winDark.castShadow=false; winDark.receiveShadow=false;
  let wi=0;
  // Pour rester aligné sur le tri par level, on construit ENTRELACÉ : pour
  // chaque slot dans l'ordre, on ajoute ses 3 fenêtres dark.
  slots.forEach((s)=>{
    const cfg=VARIANTS[s.variant];
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);
    // fenêtre rdc front (décalée droite)
    let lo=new THREE.Vector3(cfg.w*0.20, 0.30 + 1.6, cfg.d/2 + 0.04);
    lo.applyQuaternion(Q);
    P.set(s.x + lo.x, lo.y, s.z + lo.z); M.compose(P, Q, S); winDark.setMatrixAt(wi++, M);
    // arrière
    lo.set(0, 0.30 + cfg.h*0.50, -cfg.d/2 - 0.04); lo.applyQuaternion(Q);
    P.set(s.x + lo.x, lo.y, s.z + lo.z); M.compose(P, Q, S); winDark.setMatrixAt(wi++, M);
    // côté
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot - Math.PI/2);
    lo.set(0, 0.30 + cfg.h*0.50, cfg.w/2 + 0.04); lo.applyQuaternion(Q);
    Q.setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot);   // restore Q
    P.set(s.x + lo.x, lo.y, s.z + lo.z);
    // recalcule rotation pour la fenêtre côté
    const Qside=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), s.rot + Math.PI/2);
    M.compose(P, Qside, S); winDark.setMatrixAt(wi++, M);
  });
  winDark.instanceMatrix.needsUpdate=true;
  g.add(winDark); Quartier.winDarkIM=winDark;

  // ----- PAVÉ DES RUELLES (paneaux séparés, visibilité par level) -----
  const pave=paveTexture(0);
  pave.map.repeat.set(3, 1); pave.roughnessMap.repeat.set(3, 1);
  const matPave=new THREE.MeshStandardMaterial({
    color:0x55473a, map:pave.map, roughnessMap:pave.roughnessMap, roughness:1.0, metalness:0,
  });
  const addRuelle=(x, z, w, d, level)=>{
    const r=new THREE.Mesh(new THREE.PlaneGeometry(w, d), matPave);
    r.rotation.x=-Math.PI/2; r.position.set(x, 0.02, z); r.receiveShadow=true;
    g.add(r); Quartier.details.push({obj:r, level});
  };
  addRuelle(0, 0, 2.8, 18, 1);                   // ruelle centrale
  addRuelle(-12, 0, 2.8, 14, 2);                  // ruelle ouest
  addRuelle(12, 0, 2.8, 14, 3);                   // ruelle est
  addRuelle(0, 14, 2.8, 12, 4);                   // extension sud
  addRuelle(0, 22, 2.8, 8, 5);                    // dernier tronçon
  // ruelle perpendiculaire (relie centrale → est/ouest)
  addRuelle(0, -10, 28, 2.4, 3);

  // ----- LINGE TENDU dans la ruelle centrale (level 2+) -----
  for(let i=0;i<3;i++){
    const lin=createLaundryLine(2.6, 3.5);
    lin.position.set(0, 0, -4 + i*4.0);
    g.add(lin); Quartier.details.push({obj:lin, level:2});
  }
  for(let i=0;i<2;i++){
    const lin=createLaundryLine(2.6, 3.2);
    lin.position.set(-12, 0, -3 + i*5.0);
    g.add(lin); Quartier.details.push({obj:lin, level:3});
  }

  // ----- POMPE COMMUNE (level 2) -----
  const pompe=new THREE.Group();
  const base=new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.6), matFer);
  base.position.y=0.09; pompe.add(base);
  const fut=new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.12, 1.20, 8), matFer);
  fut.position.y=0.78; pompe.add(fut);
  const bec=new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.10, 0.10), matFer);
  bec.position.set(0.17, 1.20, 0); pompe.add(bec);
  const levier=new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.06), matFer);
  levier.position.set(-0.20, 1.50, 0); pompe.add(levier);
  pompe.position.set(0, 0, 0);
  g.add(pompe); Quartier.details.push({obj:pompe, level:2});

  // ----- LAMPADAIRES DE RUELLE (cohérents M4) -----
  // 2 lampadaires niveau 1, +2 niveau 3, +1 niveau 5
  const lampPositions=[
    [0, -8, 1], [0, 8, 1],
    [-12, -4, 3], [12, -4, 3],
    [0, 20, 5],
  ];
  for(const [lx, lz, lvl] of lampPositions){
    const lp=createLampPost(); lp.position.set(lx, 0, lz);
    g.add(lp); Quartier.details.push({obj:lp, level:lvl});
  }

  // ----- BANC près de la ruelle centrale (level 1) -----
  const banc=new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.40, 0.7), matBois);
  banc.position.set(-2.5, 0.20, -10); banc.castShadow=true;
  g.add(banc); Quartier.details.push({obj:banc, level:1});

  // ----- COMPUTE COUNTS BY LEVEL (clé : zéro alloc en update) -----
  Quartier.perVariantCountByLevel=[];
  for(let v=0; v<4; v++){
    const arr=byVariant[v];
    const cnts=[0,0,0,0,0,0];
    for(let lvl=0; lvl<=5; lvl++){
      cnts[lvl]=arr.filter(s=>s.level<=lvl).length;
    }
    Quartier.perVariantCountByLevel[v]=cnts;
  }
  const totalCnt=[0,0,0,0,0,0];
  for(let lvl=0; lvl<=5; lvl++) totalCnt[lvl]=slots.filter(s=>s.level<=lvl).length;
  Quartier.totalCountByLevel=totalCnt;
  Quartier.doorCountByLevel=totalCnt;
  Quartier.chimCountByLevel=totalCnt;
  Quartier.winLitCountByLevel=totalCnt;
  // winDark = 3 par slot
  Quartier.winDarkCountByLevel=totalCnt.map(c=>c*3);

  // ----- ANCRE D'INTERACTION (la maison principale, ouest centre) -----
  // Trouve le slot le plus proche de l'origine — c'est celui qu'on désigne
  // comme « entrée » du quartier pour le gameplay.
  Quartier.anchorObj={position:new THREE.Vector3(slots[0].x, 0.30, slots[0].z)};

  // Visibilité initiale = niveau 0 (3 masures éparses).
  updateQuartier(0);
}
function _computeQuartierLevel(){
  if(typeof state==='undefined' || !state) return 0;
  const pc=state.profitCumule || 0;
  const nv=state.niveauVille || 0;
  const cy=state.cycle || 0;
  // Plusieurs sources convergent : max des contributions, capé à 5.
  return Math.min(5, Math.max(
    Math.floor(nv * 0.85),         // niveauVille 7 → 5.95 → 5
    Math.floor(pc / 1500),         // 7500 profit → 5
    Math.floor(cy / 3)             // 15 cycles → 5
  ));
}
function updateQuartier(dt){
  if(!Quartier.built) return;
  const lvl=_computeQuartierLevel();
  if(lvl !== Quartier.level){
    Quartier.level=lvl;
    // Variants — count = nombre de slots de ce variant avec level ≤ lvl.
    for(let v=0; v<4; v++){
      const cnt=(Quartier.perVariantCountByLevel[v] && Quartier.perVariantCountByLevel[v][lvl]) || 0;
      if(Quartier.bodyIM[v])   Quartier.bodyIM[v].count   = cnt;
      if(Quartier.plinthIM[v]) Quartier.plinthIM[v].count = cnt;
      if(Quartier.roofIM[v])   Quartier.roofIM[v].count   = cnt;
    }
    if(Quartier.doorIM)    Quartier.doorIM.count    = Quartier.doorCountByLevel[lvl];
    if(Quartier.chimIM)    Quartier.chimIM.count    = Quartier.chimCountByLevel[lvl];
    if(Quartier.winLitIM)  Quartier.winLitIM.count  = Quartier.winLitCountByLevel[lvl];
    if(Quartier.winDarkIM) Quartier.winDarkIM.count = Quartier.winDarkCountByLevel[lvl];
    for(const d of Quartier.details) d.obj.visible = d.level <= lvl;
  }
  // Fenêtres allumées : intensité pilotée par DayCycle.kDay + chômage M4.
  if(Quartier.litMat){
    const night=Math.max(0, 1 - (DayCycle.kDay || 1) * 1.7);
    const chom=(M4 && M4.s_chomage) ? M4.s_chomage : 0;
    // densité décroît avec chômage : on simule en dimmant les fenêtres allumées
    // (au lieu d'allumer/éteindre par instance — InstancedMesh partage le material).
    const densityK=1.0 - chom*0.6;
    Quartier.litMat.emissiveIntensity = night * 1.5 * densityK;
  }
}

function buildMarcheMP(g){            // HALLE BALTARD — fer + verre + colonnes fonte
  const matFonte=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matFerLight=new THREE.MeshStandardMaterial({color:0x3a322a, roughness:0.6, metalness:0.5, flatShading:true});
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x6b6055, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  // VERRIÈRE émissive DOUCE (gasLight, pas forge — le marché brille tranquille)
  const matVerriere=new THREE.MeshStandardMaterial({
    color:0x5a564f, emissive:new THREE.Color(COLORSCRIPT.gasLight), emissiveIntensity:0.55,
    transparent:true, opacity:0.85,
    roughness:0.4, metalness:0.4, flatShading:true,
  });

  // SOUBASSEMENT + plinthe en pierre
  g.add(_M5_box(17.0, 0.40, 10.0, matPierre, 0, -0.05, -1));
  g.add(_M5_box(16.4, 0.50, 9.4, matPierre, 0, 0.25, -1));

  // MUR BAS en brique périphérique (~1 m de haut)
  // 4 panneaux, laissant des coins ouverts pour les colonnes d'angle
  const wallH=1.2, wallTh=0.30;
  // façades nord + sud
  g.add(_M5_box(16.0, wallH, wallTh, matBrique, 0, 0.50 + wallH/2, -1 - 4.5 - wallTh/2));
  g.add(_M5_box(16.0, wallH, wallTh, matBrique, 0, 0.50 + wallH/2, -1 + 4.5 + wallTh/2));
  // flancs (avec ouverture centrale 2.4 m)
  for(const sx of [-1, 1]){
    g.add(_M5_box(wallTh, wallH, 3.0, matBrique, sx*(8.0 + wallTh/2), 0.50 + wallH/2, -1 - 2.7));
    g.add(_M5_box(wallTh, wallH, 3.0, matBrique, sx*(8.0 + wallTh/2), 0.50 + wallH/2, -1 + 2.7));
  }
  // bandeau de pierre au-dessus du mur bas (couronnement)
  for(const sz of [-1, 1])
    g.add(_M5_box(16.8, 0.18, 0.36, matPierre, 0, 0.50 + wallH + 0.09, -1 + sz*(4.5 + wallTh)));
  for(const sx of [-1, 1])
    g.add(_M5_box(0.36, 0.18, 9.4, matPierre, sx*(8.0 + wallTh), 0.50 + wallH + 0.09, -1));

  // COLONNES de FONTE — fines, fluted (suggéré par cylindres + bagues)
  const colH=5.2;
  for(let i=0; i<6; i++){
    for(const sz of [-1, 1]){
      const cx=-7.0 + i*2.8;
      const cz=-1 + sz*4.3;
      // base carrée
      g.add(_M5_box(0.45, 0.20, 0.45, matFonte, cx, 0.62, cz));
      // fût
      const shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, colH, 12), matFonte);
      shaft.position.set(cx, 0.72 + colH/2, cz); g.add(shaft);
      // chapiteau
      g.add(_M5_box(0.40, 0.20, 0.40, matFonte, cx, 0.72 + colH + 0.10, cz));
      // bague à mi-hauteur
      g.add(_M5_box(0.22, 0.10, 0.22, matFonte, cx, 0.72 + colH*0.5, cz));
    }
  }
  // 2 colonnes centrales (longue arête médiane — soutiennent le faîte)
  for(let i=0; i<4; i++){
    const cx=-5.0 + i*3.3;
    const shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, colH+1.5, 12), matFonte);
    shaft.position.set(cx, 0.62 + (colH+1.5)/2, -1);
    g.add(shaft);
    g.add(_M5_box(0.40, 0.20, 0.40, matFonte, cx, 0.62 + colH+1.5 + 0.10, -1));
  }

  // POUTRES MAÎTRESSES horizontales (fer en treillis) — connectent les colonnes
  // 4 poutres longitudinales le long de chaque côté + 6 poutres transversales
  for(const sz of [-1, 1]){
    g.add(_M5_box(16.0, 0.18, 0.18, matFonte, 0, 0.72 + colH + 0.22, -1 + sz*4.3));
  }
  for(let i=0; i<6; i++){
    const cx=-7.0 + i*2.8;
    g.add(_M5_box(0.18, 0.18, 8.4, matFonte, cx, 0.72 + colH + 0.22, -1));
  }
  // faîtière centrale (plus haute)
  g.add(_M5_box(15.0, 0.20, 0.20, matFonte, 0, 0.62 + colH + 1.5 + 0.22, -1));

  // VERRIÈRE — toit à 2 pentes en panneaux vitrés
  const slope=0.45;
  const panLen=Math.hypot(4.3, 1.7);
  for(const sz of [-1, 1]){
    const panel=new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.10, panLen + 0.4), matVerriere);
    panel.rotation.x = sz * slope;
    panel.position.set(0, 0.72 + colH + 1.0, -1 + sz*4.3*0.5);
    g.add(panel);
  }
  // structure fer entre les panneaux (faîtage)
  g.add(_M5_box(15.6, 0.20, 0.20, matFonte, 0, 0.72 + colH + 1.6, -1));
  // PIGNONS — fer + verre pour fermer les bouts (volume clos)
  for(const sx of [-1, 1]){
    const gablShape=new THREE.Shape();
    gablShape.moveTo(-4.5, 0); gablShape.lineTo(4.5, 0);
    gablShape.lineTo(0, 1.5); gablShape.lineTo(-4.5, 0);
    const gablGeo=new THREE.ExtrudeGeometry(gablShape, {depth: 0.12, bevelEnabled:false});
    const gable=new THREE.Mesh(gablGeo, matVerriere);
    gable.position.set(sx*8.0, 0.72 + colH + 0.20, -1);
    gable.rotation.y=sx>0 ? Math.PI/2 : -Math.PI/2;
    g.add(gable);
  }

  // SOL PAVÉ sous la halle
  const pave=paveTexture(2);
  pave.map.repeat.set(3, 2); pave.roughnessMap.repeat.set(3, 2);
  const sol=new THREE.Mesh(new THREE.PlaneGeometry(15.4, 8.4),
    new THREE.MeshStandardMaterial({color:0x88796a, map:pave.map, roughnessMap:pave.roughnessMap, roughness:1.0, metalness:0}));
  sol.rotation.x=-Math.PI/2; sol.position.set(0, 0.55, -1);
  sol.receiveShadow=true; g.add(sol);

  // ÉTALS sous la halle (3 stalls espacés)
  for(let i=0; i<3; i++){
    const stall=createMarketStall(i%2 ? COL.rouge : COL.bleu);
    stall.position.set(-4.5 + i*4.5, 0.55, -1);
    g.add(stall);
  }

  // MARCHANDISES (existant)
  const coal=createCoalPile(); coal.position.set(6, 0.55, 1.8); g.add(coal);
  for(let i=0; i<3; i++){
    const s=createSack(i%2 ? 0xc9b78c : 0xbfa97e);
    s.position.set(-7+i*1.2, 0.55, 1.8); g.add(s);
  }
  const fer=createCrate(1.4, 0x8a8076); fer.position.set(-7, 0.55, -0.5); g.add(fer);
  const cart=createSmallCart(); cart.position.set(0, 0.55, 2.6); g.add(cart);

  // ENSEIGNE M
  const sp=createSign('M'); sp.scale.set(2.4, 1.7, 1);
  sp.position.set(0, 0.72 + colH + 1.5, 3.6); g.add(sp);
}

function buildMarcheTravail(g){       // PLACE SOCIALE — bureau d'embauche + mur d'affiches
  const brique=briqueTexture('std');
  const matBrique=new THREE.MeshStandardMaterial({
    color:0x5a3026, map:brique.map, roughnessMap:brique.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const briqueH=briqueTexture('haut');
  const matBriqueH=new THREE.MeshStandardMaterial({
    color:0x4a2620, map:briqueH.map, roughnessMap:briqueH.roughnessMap,
    roughness:1.0, metalness:0,
  });
  const pierre=pierreDeTailleTexture('sombre');
  const matPierre=new THREE.MeshStandardMaterial({
    color:0x6b6055, map:pierre.map, roughnessMap:pierre.roughnessMap, roughness:1.0, metalness:0,
  });
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matToit=new THREE.MeshStandardMaterial({color:0x3a2a20, roughness:0.95, metalness:0, flatShading:true});

  // BUREAU D'EMBAUCHE (volume CLOS)
  // empreinte 6×4 ; soubassement + plinthe + corps + corniche + toit pitched fermé
  const bcx=-3, bcz=-2;
  g.add(_M5_box(6.6, 0.30, 4.6, matPierre, bcx, -0.05, bcz));
  g.add(_M5_box(6.2, 0.45, 4.2, matPierre, bcx, 0.225, bcz));
  g.add(_M5_box(6.0, 3.4, 4.0, matBrique, bcx, 0.45 + 1.7, bcz));
  // bandeaux
  g.add(_M5_box(6.2, 0.18, 4.2, matBriqueH, bcx, 0.45 + 3.4 + 0.09, bcz));
  // toit pitched fermé
  const bRoof=_M6_pitchedClosed(6.4, 4.4, 1.2, matToit, matBriqueH);
  bRoof.position.set(bcx, 0.45 + 3.4 + 0.18, bcz); g.add(bRoof);
  // petite cheminée
  g.add(_M5_box(0.40, 1.0, 0.40, matBriqueH, bcx + 2.0, 0.45 + 3.4 + 0.50, bcz - 0.8));

  // GUICHET (petit comptoir saillant côté façade +Z)
  g.add(_M5_box(2.0, 1.6, 0.55, matBois, bcx + 1.6, 0.45 + 0.80, bcz + 2.05));
  // tablette du guichet
  g.add(_M5_box(2.2, 0.10, 0.65, matPierre, bcx + 1.6, 0.45 + 1.62, bcz + 2.05));
  // grille du guichet
  for(let i=0; i<5; i++){
    g.add(_M5_box(0.03, 0.5, 0.03, matFer, bcx + 0.7 + i*0.45, 0.45 + 2.05, bcz + 2.10));
  }

  // PORTE
  const dr=createDoor(1.0, 2.0, 0x281f17); dr.position.set(bcx - 1.6, 0.45, bcz + 2.0); g.add(dr);

  // FENÊTRES (façade + flancs + arrière)
  for(const wx of [bcx - 1.6 + 0.85]){
    const w=createWindow(0.6, 0.85); w.position.set(wx, 0.45 + 2.4, bcz + 2.04); g.add(w);
  }
  for(const sx of [-1, 1]){
    const w=createWindow(0.55, 0.8); w.position.set(bcx + sx*3.04, 0.45 + 2.0, bcz);
    w.rotation.y = sx>0 ? -Math.PI/2 : Math.PI/2; g.add(w);
  }
  // arrière
  for(const fx of [bcx - 1.5, bcx + 1.5]){
    const w=createWindow(0.55, 0.8); w.position.set(fx, 0.45 + 2.0, bcz - 2.04);
    w.rotation.y=Math.PI; g.add(w);
  }

  // MUR D'AFFICHES D'EMBAUCHE — 4 m de long, devant le bureau côté droit
  // panneau bois + 6 affiches en planche colorée avec texte
  const wallCx=2.5, wallCz=-1.5;
  g.add(_M5_box(4.8, 2.6, 0.20, matBois, wallCx, 1.30, wallCz));
  // poteaux du mur
  for(const sx of [-1, 1])
    g.add(_M5_box(0.20, 3.0, 0.20, matBois, wallCx + sx*2.4, 1.50, wallCz));
  // toit débord (auvent) au-dessus du mur
  g.add(_M5_box(5.2, 0.10, 0.85, matBois, wallCx, 2.75, wallCz + 0.32, false));
  // 6 AFFICHES — créées par helper avec textes d'époque
  const affichesT=[
    'CHERCHE OUVRIERS\nUSINE BRANDT\n14 H/jour',
    'TISSEURS\nÉCHELLE EXTRA',
    'EMBAUCHE\nCHARRETIERS',
    'MANŒUVRES\nde toutes mains',
    'ON DEMANDE\nFEMMES\n+ ENFANTS',
    'JOURNALIERS\nSOLDE QUOTIDIEN',
  ];
  for(let i=0; i<6; i++){
    const af=_M6_afficheTex(affichesT[i], i);
    const cx=wallCx - 2.0 + (i % 3)*2.0;
    const cy= i < 3 ? 1.85 : 1.05;
    const affiche=new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.90),
      new THREE.MeshStandardMaterial({map:af, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true}));
    affiche.position.set(cx, cy, wallCz + 0.11);
    g.add(affiche);
  }

  // BARRIÈRE DE FILE en fer (zigzag) — 4 segments simples
  const matRail=new THREE.MeshStandardMaterial({color:0x14181f, roughness:0.5, metalness:0.7, flatShading:true});
  for(let i=0; i<4; i++){
    const bx=0.5 + (i%2)*1.4;
    const bz=1.5 - i*1.2;
    // poteau
    g.add(_M5_box(0.10, 1.0, 0.10, matRail, bx, 0.5, bz));
    // rail vers le suivant
    if(i < 3){
      const nbx=0.5 + ((i+1)%2)*1.4;
      const nbz=1.5 - (i+1)*1.2;
      const dx=nbx - bx, dz=nbz - bz;
      const L=Math.hypot(dx, dz);
      const rail=_M5_box(L, 0.04, 0.06, matRail, (bx+nbx)/2, 0.85, (bz+nbz)/2, false);
      rail.rotation.y=Math.atan2(dx, dz) - Math.PI/2;
      g.add(rail);
    }
  }

  // BANC (existant)
  g.add(_M5_box(3.4, 0.40, 0.70, matBois, 4, 0.40, -3));

  // ENSEIGNE Ft
  const sp=createSign('Ft'); sp.scale.set(2.4, 1.6, 1); sp.position.set(bcx, 5.3, bcz + 2.1); g.add(sp);
}

/* _M6_afficheTex — affiche d'embauche canvas avec typo d'époque (script + numéral) */
function _M6_afficheTex(text, seed=0){
  const c=document.createElement('canvas'); c.width=256; c.height=320;
  const x=c.getContext('2d');
  // papier jauni vieilli
  const baseR=224+(seed*7) % 16, baseG=210+(seed*5) % 12, baseB=180+(seed*3) % 14;
  x.fillStyle=`rgb(${baseR},${baseG},${baseB})`;
  x.fillRect(0,0,256,320);
  // taches d'usure
  for(let i=0; i<20; i++){
    x.fillStyle='rgba(80,60,40,0.10)';
    x.beginPath(); x.arc(Math.random()*256, Math.random()*320, 4+Math.random()*12, 0, Math.PI*2); x.fill();
  }
  // bord (cadre noir simple)
  x.strokeStyle='#241f17'; x.lineWidth=4;
  x.strokeRect(8, 8, 240, 304);
  // ornement haut
  x.strokeStyle='#241f17'; x.lineWidth=1.5;
  for(let i=0; i<8; i++){
    x.beginPath(); x.arc(32+i*28, 32, 5, 0, Math.PI*2); x.stroke();
  }
  // texte
  x.fillStyle='#181410'; x.textAlign='center';
  const lines=text.split('\n');
  let fontH=lines[0].length > 12 ? 22 : 26;
  for(let i=0; i<lines.length; i++){
    x.font=`700 ${i===0 ? fontH : fontH-4}px "Zilla Slab", serif`;
    x.fillText(lines[i], 128, 80 + i*32);
  }
  // numéral d'époque en bas
  x.font='italic 18px "Zilla Slab", serif';
  x.fillText('Ann. ' + (1850 + (seed*7)%30), 128, 290);
  const tex=new THREE.CanvasTexture(c);
  return tex;
}
function buildEtat(g){               // « la machine froide » — rigide, administrative
  const enduit=enduitTexture();
  const matEnduit=new THREE.MeshStandardMaterial({
    color:0x8c93a4, map:enduit.map, roughnessMap:enduit.roughnessMap,
    roughness:0.95, metalness:0.0,
  });
  const matEnduitDark=new THREE.MeshStandardMaterial({
    color:0x6b7080, map:enduit.map, roughnessMap:enduit.roughnessMap,
    roughness:0.95, metalness:0.0,
  });
  const matIron=new THREE.MeshStandardMaterial({color:0x14181f, roughness:0.5, metalness:0.7, flatShading:true});

  // helper local : box() crée son propre material — on le SWAP par celui partagé.
  const swap=(m, mat)=>{ m.material=mat; return m; };

  // ---------- SOUBASSEMENT débordant (M5b — ancrage au sol) ----------
  const soubShape=_roundedRectShape(13.6, 9.6, 0.10);
  const soubGeo=new THREE.ExtrudeGeometry(soubShape,{depth:0.45,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  soubGeo.rotateX(-Math.PI/2); soubGeo.translate(0,-0.18,0);
  const soub=new THREE.Mesh(soubGeo, matEnduitDark); soub.receiveShadow=true;
  g.add(soub);

  // ---------- GRILLE EN FAÇADE + MURET BAS + parvis ----------
  // M5b — la grille est assise sur un muret bas, plus de barreaux flottants
  const muret=swap(box(11.4, 0.35, 0.32, 0x787f8d, 0, 0.175, 6.0, false), matEnduitDark);
  g.add(muret);
  const grille=createIronFence(11, 1.9);
  grille.position.set(0, 0.35, 6.0); g.add(grille);
  g.add(swap(box(13, 0.18, 1.6, 0x787f8d, 0, 0.09, 5.2, false), matEnduitDark));

  // ---------- MARCHES (courte volée — austère) ----------
  for(let i=0;i<3;i++){
    g.add(swap(box(11 - i*0.4, 0.32, 0.9, 0x8c93a4, 0, 0.16+i*0.32, 4.0+i*0.7, false), matEnduit));
  }

  // ---------- PLINTHE (extrude) ----------
  const plinShape=_roundedRectShape(13, 9, 0.08);
  const plinGeo=new THREE.ExtrudeGeometry(plinShape,{depth:1.0,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  plinGeo.rotateX(-Math.PI/2);
  const plin=new THREE.Mesh(plinGeo, matEnduitDark);
  plin.castShadow=true; plin.receiveShadow=true; g.add(plin);

  // ---------- CORPS ----------
  const bodyShape=_roundedRectShape(12, 8, 0.06);
  const bodyGeo=new THREE.ExtrudeGeometry(bodyShape,{depth:7.6,bevelEnabled:true,
    bevelSize:0.04,bevelThickness:0.04,bevelSegments:1,steps:1});
  bodyGeo.rotateX(-Math.PI/2); bodyGeo.translate(0,1.0,0);
  const body=new THREE.Mesh(bodyGeo, matEnduit);
  body.castShadow=true; body.receiveShadow=true; g.add(body);

  // ---------- CORNICHE (débord net) ----------
  const corShape=_roundedRectShape(13, 9, 0.08);
  const corGeo=new THREE.ExtrudeGeometry(corShape,{depth:0.48,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  corGeo.rotateX(-Math.PI/2); corGeo.translate(0,8.6,0);
  const corniche=new THREE.Mesh(corGeo, matEnduitDark); corniche.castShadow=true;
  g.add(corniche);
  // bande de pluie discrète sous corniche
  _addAt(g, new THREE.Mesh(new THREE.PlaneGeometry(11.5, 0.45),
    new THREE.MeshBasicMaterial({color:0x2f343d, transparent:true, opacity:0.28, depthWrite:false})),
    0, 8.4, 4.05);

  // ---------- PILASTRES en façade (austère, pas d'ordre ionique) ----------
  for(let i=0;i<5;i++){
    g.add(swap(box(0.4, 6.6, 0.28, 0x6b7080, -4.4+i*2.2, 4.3, 4.02, false), matEnduitDark));
    // chapiteau plat
    g.add(swap(box(0.55, 0.20, 0.40, 0x6b7080, -4.4+i*2.2, 7.7, 4.04, false), matEnduitDark));
  }

  // ---------- FENÊTRES RÉGULIÈRES + PARCIMONIEUSES (encadrements en relief) ----------
  // 2 niveaux × 4 entre-colonnements (3 fenêtres centrées par niveau)
  const winY=[3.2, 6.0];
  for(const wy of winY){
    for(let i=0;i<4;i++){
      const wx=-3.3 + i*2.2;
      // encadrement saillant (relief)
      g.add(swap(box(1.0, 1.8, 0.08, 0x6b7080, wx, wy, 4.06, false), matEnduitDark));
      const w=createWindow(0.78, 1.5);
      w.position.set(wx, wy, 4.13); g.add(w);
      // appui de fenêtre
      g.add(swap(box(1.1, 0.10, 0.18, 0x6b7080, wx, wy-0.9, 4.10, false), matEnduitDark));
    }
  }

  // ---------- FENÊTRES LATÉRALES (M5b — le volume n'est plus aveugle) ----------
  // 3 fenêtres par flanc, à 2 niveaux. Encadrement saillant rappel de la façade.
  for(const sx of [-1, 1]){
    for(const wy of winY){
      for(const wz of [-2.6, 0, 2.6]){
        _addAt(g, swap(box(0.08, 1.6, 0.92, 0x6b7080, sx*6.01, wy, wz, false), matEnduitDark));
        const w=createWindow(0.72, 1.35);
        w.position.set(sx*6.08, wy, wz);
        w.rotation.y = sx>0 ? -Math.PI/2 : Math.PI/2;
        g.add(w);
      }
    }
    // appuis de fenêtre côté (alignés sur niveau bas)
    for(const wz of [-2.6, 0, 2.6])
      _addAt(g, swap(box(0.18, 0.10, 1.0, 0x6b7080, sx*6.02, winY[0]-0.9, wz, false), matEnduitDark));
    // pilastres austères sur les flancs aussi
    for(const wz of [-3.4, -1.0, 1.0, 3.4])
      _addAt(g, swap(box(0.26, 6.4, 0.36, 0x6b7080, sx*6.01, 4.3, wz, false), matEnduitDark));
  }

  // ---------- FAÇADE ARRIÈRE (M5b — sobre mais TRAITÉE) ----------
  // pilastres + 3 fenêtres + porte de service centrée
  for(const fx of [-4.4, -2.2, 0, 2.2, 4.4])
    _addAt(g, swap(box(0.4, 6.6, 0.28, 0x6b7080, fx, 4.3, -4.02, false), matEnduitDark));
  for(const wy of winY){
    for(const fx of [-2.6, 0, 2.6]){
      _addAt(g, swap(box(1.0, 1.6, 0.08, 0x6b7080, fx, wy, -4.06, false), matEnduitDark));
      const w=createWindow(0.72, 1.35);
      w.position.set(fx, wy, -4.13); w.rotation.y=Math.PI; g.add(w);
      _addAt(g, swap(box(1.1, 0.10, 0.18, 0x6b7080, fx, wy-0.9, -4.10, false), matEnduitDark));
    }
  }
  // porte de service arrière
  const backDoor=swap(box(1.6, 2.4, 0.10, 0x14181f, 0, 1.2, -4.10, false), matEnduitDark);
  g.add(backDoor);

  // ---------- TOIT FERMÉ : dalle légèrement saillante au-dessus de la corniche ----------
  const roofE=new THREE.Mesh(new THREE.BoxGeometry(12.8, 0.22, 8.8),
    new THREE.MeshStandardMaterial({color:0x4f5260, roughness:0.95, metalness:0}));
  roofE.position.set(0, 9.10, 0); roofE.receiveShadow=true; g.add(roofE);

  // ---------- FRONTON triangulaire avec SCEAU ----------
  const pediShape=new THREE.Shape();
  pediShape.moveTo(-6.4, 0); pediShape.lineTo(6.4, 0);
  pediShape.lineTo(0, 2.4); pediShape.lineTo(-6.4, 0);
  const pediGeo=new THREE.ExtrudeGeometry(pediShape,{depth:1.4,bevelEnabled:true,
    bevelSize:0.05,bevelThickness:0.05,bevelSegments:1,steps:1});
  pediGeo.translate(0, 8.85, 3.9);
  const pediment=new THREE.Mesh(pediGeo, matEnduit); pediment.castShadow=true;
  g.add(pediment);
  // SCEAU en relief (cylindre + détail)
  const seal=new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.18, 24),
    new THREE.MeshStandardMaterial({color:0x4a5060, roughness:0.5, metalness:0.6, flatShading:true}));
  seal.rotation.x=Math.PI/2;
  seal.position.set(0, 9.7, 5.40); g.add(seal);
  // étoile au centre du sceau
  for(let i=0;i<5;i++){
    const a=(i/5)*Math.PI*2 - Math.PI/2;
    _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.32, 0.04),
      new THREE.MeshStandardMaterial({color:0x2a2c34, flatShading:true})),
      Math.cos(a)*0.16, 9.7+Math.sin(a)*0.16, 5.48);
  }

  // ---------- CAMPANILE D'HORLOGE (centre-arrière) ----------
  const towerW=2.6, towerH=5.4;
  const towerCx=-3.2, towerCz=-1.6;
  const tower=new THREE.Mesh(new THREE.BoxGeometry(towerW, towerH, towerW), matEnduit);
  tower.position.set(towerCx, 8.6 + towerH/2, towerCz);
  tower.castShadow=true; g.add(tower);
  // bandeau du beffroi
  _addAt(g, new THREE.Mesh(new THREE.BoxGeometry(towerW+0.3, 0.22, towerW+0.3), matEnduitDark),
    towerCx, 8.6 + towerH - 0.55, towerCz);
  // CADRAN émissif (cold white) — couplage M4 horloge (intensité = parfaitement stable)
  const clockMat=new THREE.MeshStandardMaterial({
    color:0xdfe2eb, emissive:new THREE.Color(0xcfd6e4), emissiveIntensity:1.15,
    roughness:0.5, metalness:0.1, flatShading:true,
  });
  clockMat.userData.m4Role='etat-horloge';
  const clock=new THREE.Mesh(new THREE.CircleGeometry(0.82, 24), clockMat);
  clock.position.set(towerCx, 8.6 + towerH*0.55, towerCz + towerW/2 + 0.02);
  g.add(clock);
  // anneau (cadran encadré)
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.06, 4, 24),
    new THREE.MeshStandardMaterial({color:0x2a2c34, roughness:0.5, metalness:0.6, flatShading:true}));
  ring.position.copy(clock.position); ring.position.z+=0.01;
  g.add(ring);
  // aiguilles
  const handsMat=new THREE.MeshStandardMaterial({color:0x14181f, flatShading:true});
  const hourHand=new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.03), handsMat);
  hourHand.position.copy(clock.position); hourHand.position.z+=0.05;
  hourHand.position.y += 0.18; hourHand.rotation.z=-0.7; g.add(hourHand);
  const minHand=new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.62, 0.03), handsMat);
  minHand.position.copy(clock.position); minHand.position.z+=0.06;
  minHand.position.y += 0.25; minHand.rotation.z=0.5; g.add(minHand);
  // toit pyramidal du campanile
  const towerCap=new THREE.Mesh(new THREE.ConeGeometry(towerW*0.78, 1.6, 4), matEnduitDark);
  towerCap.rotation.y=Math.PI/4;
  towerCap.position.set(towerCx, 8.6 + towerH + 0.80, towerCz); g.add(towerCap);
  // mât de drapeau au sommet
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), matIron);
  mast.position.set(towerCx, 8.6 + towerH + 1.6 + 1.3, towerCz); g.add(mast);
  const flag=new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95),
    new THREE.MeshStandardMaterial({color:0x2a2c34, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true}));
  flag.position.set(towerCx + 0.78, 8.6 + towerH + 1.6 + 1.7, towerCz); g.add(flag);

  // ---------- PORTE BRONZE ----------
  const door=createBronzeDoor(2.2, 3.4);
  door.position.set(0, 0, 4.10); g.add(door);

  // ---------- ENSEIGNE ÉTAT ----------
  const sp=createSign('ÉTAT'); sp.scale.set(3, 1.4, 1);
  sp.position.set(0, 7.7, 4.18); g.add(sp);

  // ---------- TAMPON ROUGE (clin d'œil bureaucratique, intact) ----------
  g.add(box(1.0, 1.0, 0.10, COL.rouge, 4.6, 5.2, 4.10, false));
}
/* =====================================================================
   M6 Lot C — ARBRES AMÉLIORÉS pour les terres communes.
   3 gabarits : trogne (large, court, ramassé), peuplier (étroit, élancé),
   chêne (large, arrondi). Troncs en cylindres IRRÉGULIERS (segments
   décalés), feuillage en sphères déformées (PAS de cônes — la doctrine
   M6 interdit les cônes pour les arbres).
   ===================================================================== */
function _M6_tree(kind='chene'){
  const g=new THREE.Group();
  const matTronc=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matFeuillage=new THREE.MeshStandardMaterial({color:0x6b7a4a, roughness:0.95, metalness:0, flatShading:true});
  const matFeuillageS=new THREE.MeshStandardMaterial({color:0x5a6a3e, roughness:0.95, metalness:0, flatShading:true});
  if(kind==='trogne'){
    // trogne : tronc court (1.5m), épais, branche-en-tête en boule rabattue + petites repousses
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 1.6, 8), matTronc);
    trunk.position.y=0.8; g.add(trunk);
    // segment supérieur élargi (la tête noueuse)
    const head=new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.55, 0.4, 8), matTronc);
    head.position.y=1.80; g.add(head);
    // feuillage : 1 grosse sphère aplatie + 3 petites repousses
    const main=new THREE.Mesh(new THREE.SphereGeometry(1.35, 8, 6), matFeuillage);
    main.scale.set(1.0, 0.55, 1.0);
    main.position.y=2.4; g.add(main);
    for(let i=0; i<3; i++){
      const a=(i/3)*Math.PI*2;
      const sm=new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), matFeuillageS);
      sm.scale.set(0.95, 0.85, 0.95);
      sm.position.set(Math.cos(a)*1.1, 2.0 + Math.sin(a)*0.3, Math.sin(a)*1.1);
      g.add(sm);
    }
  } else if(kind==='peuplier'){
    // peuplier : étroit, élancé, tronc 5m, feuillage en colonne (sphères empilées)
    // tronc en 3 segments légèrement décalés (irrégularité)
    const segs=[
      {r1:0.30, r2:0.34, h:1.8, y:0.9, dx:0, dz:0},
      {r1:0.26, r2:0.30, h:1.8, y:2.7, dx:0.04, dz:0.02},
      {r1:0.20, r2:0.26, h:1.8, y:4.5, dx:0.06, dz:-0.03},
    ];
    for(const s of segs){
      const m=new THREE.Mesh(new THREE.CylinderGeometry(s.r1, s.r2, s.h, 8), matTronc);
      m.position.set(s.dx, s.y, s.dz); g.add(m);
    }
    // feuillage colonne : 3 sphères allongées empilées
    for(let i=0; i<3; i++){
      const m=new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 6), matFeuillage);
      m.scale.set(0.6, 1.1, 0.6);
      m.position.set((i%2 ? 0.10 : -0.05), 4.2 + i*1.3, (i%2 ? -0.05 : 0.10));
      g.add(m);
    }
    // sphère sommitale plus petite
    const top=new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), matFeuillageS);
    top.scale.set(0.6, 1.0, 0.6); top.position.y=8.4; g.add(top);
  } else {
    // CHÊNE : large couronne arrondie, tronc en 2 segments
    const seg1=new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.62, 1.6, 8), matTronc);
    seg1.position.y=0.8; g.add(seg1);
    const seg2=new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.50, 1.4, 8), matTronc);
    seg2.position.set(0.05, 2.30, -0.04); g.add(seg2);
    // couronne : 4 sphères qui se chevauchent
    const cnt=[
      [0,    3.4, 0,    1.65, 1.30, 1.65],
      [0.95, 3.7, 0.5,  1.10, 0.95, 1.10],
      [-0.7, 3.5, 0.8,  1.05, 0.90, 1.05],
      [0.4,  3.9, -0.7, 0.95, 0.85, 0.95],
    ];
    for(const [x, y, z, sx, sy, sz] of cnt){
      const m=new THREE.Mesh(new THREE.SphereGeometry(1.0, 9, 7),
        (Math.random()<0.5 ? matFeuillage : matFeuillageS));
      m.position.set(x, y, z); m.scale.set(sx, sy, sz);
      g.add(m);
    }
  }
  return g;
}

function buildTerresCommunes(g){      // CHAMPS OUVERTS PUIS CLÔTURÉS — enclosure
  // matières
  const matTerre=new THREE.MeshStandardMaterial({color:0x77833f, roughness:1.0, metalness:0, flatShading:true});
  const matTerre2=new THREE.MeshStandardMaterial({color:0x6c7838, roughness:1.0, metalness:0, flatShading:true});
  const matTerre3=new THREE.MeshStandardMaterial({color:0x807a45, roughness:1.0, metalness:0, flatShading:true});
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matHaie=new THREE.MeshStandardMaterial({color:0x5a6a3e, roughness:0.95, metalness:0, flatShading:true});

  // 3 PARCELLES (les communs labourés, séparées par sillons)
  g.add(_M5_box(7.5, 0.30, 7.5, matTerre, -8, 0.15, 0));
  g.add(_M5_box(7.5, 0.30, 7.5, matTerre2, 0, 0.15, 0));
  g.add(_M5_box(7.5, 0.30, 7.5, matTerre3, 8, 0.15, 0));
  // sillons (lignes de labour) — overlays
  for(const cx of [-8, 0, 8]){
    for(let i=-3; i<=3; i++){
      g.add(_M5_box(6.8, 0.04, 0.10,
        new THREE.MeshStandardMaterial({color:0x55603a, roughness:1.0, metalness:0, flatShading:true}),
        cx, 0.32, i*1.0, false));
    }
  }

  // CLÔTURES D'ENCLOSURE — posts + rails (3 côtés : sud + est + ouest entièrement clôturés ;
  // le côté nord reste ouvert pour préserver le couplage scénique existant).
  // Posts épais en bois, plus durs que l'ancien
  const fence=(x0, z0, x1, z1)=>{
    const dx=x1-x0, dz=z1-z0, len=Math.hypot(dx, dz);
    const n=Math.max(2, Math.round(len/2.0));
    for(let i=0; i<=n; i++){
      const x=x0 + dx*i/n, z=z0 + dz*i/n;
      const post=_M5_box(0.28, 1.6, 0.28, matBois, x, 0.80, z);
      g.add(post);
    }
    // 2 rails horizontaux
    for(const ry of [0.45, 1.15]){
      const rail=_M5_box(len, 0.18, 0.12, matBois, (x0+x1)/2, ry, (z0+z1)/2, false);
      rail.rotation.y=Math.atan2(dx, dz) - Math.PI/2;
      g.add(rail);
    }
  };
  // 3 côtés clôturés (la cage économique de l'accumulation primitive)
  fence(-11.5, -9, 11.5, -9);
  fence( 11.5, -9, 11.5,  9);
  fence(-11.5, -9, -11.5,  9);

  // HAIES BASSES (sphères de feuillage le long des clôtures)
  for(const [x0, z0, x1, z1] of [[-11.5,-9, 11.5,-9], [11.5,-9, 11.5,9], [-11.5,-9, -11.5,9]]){
    const dx=x1-x0, dz=z1-z0, len=Math.hypot(dx, dz);
    const n=Math.floor(len/1.4);
    for(let i=0; i<n; i++){
      const t=(i+0.5)/n;
      const x=x0+dx*t, z=z0+dz*t;
      const h=new THREE.Mesh(new THREE.SphereGeometry(0.55+Math.random()*0.20, 7, 5), matHaie);
      h.scale.set(1.0, 0.55, 0.85 + Math.random()*0.2);
      h.position.set(x, 0.40, z); g.add(h);
    }
  }

  // ARBRES — 3 gabarits répartis (PAS de cônes)
  // 2 chênes au centre des communs (généreux)
  const chene1=_M6_tree('chene'); chene1.position.set(-3, 0.3, 5); g.add(chene1);
  const chene2=_M6_tree('chene'); chene2.position.set(5, 0.3, -5); chene2.rotation.y=1.2; g.add(chene2);
  // 1 trogne (le bétail vient s'y abriter)
  const trogne=_M6_tree('trogne'); trogne.position.set(-7, 0.3, -6); g.add(trogne);
  // 2 peupliers en alignement (rappellent la rive)
  const peuplier1=_M6_tree('peuplier'); peuplier1.position.set(9, 0.3, 5); g.add(peuplier1);
  const peuplier2=_M6_tree('peuplier'); peuplier2.position.set(11, 0.3, 7); g.add(peuplier2);

  // PIERRE-BORNE au coin (rappel des bornes coutumières)
  g.add(_M5_box(0.40, 0.85, 0.40,
    new THREE.MeshStandardMaterial({color:0x8a7f6a, roughness:1.0, metalness:0, flatShading:true}),
    -11.5, 0.425, 8.5));
  // moutons en pierre suggérés (petites sphères blanches) — clin d'œil pastoral
  for(let i=0; i<3; i++){
    const sheep=new THREE.Mesh(new THREE.SphereGeometry(0.30, 7, 5),
      new THREE.MeshStandardMaterial({color:0xb8b09a, roughness:0.95, metalness:0, flatShading:true}));
    sheep.scale.set(1.2, 0.85, 0.8);
    sheep.position.set(-4 + i*1.5, 0.55, -3); g.add(sheep);
  }
}
function buildMines(g){               // MINES — chevalement, entrée étayée, terrils noirs
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matBoisFonce=new THREE.MeshStandardMaterial({color:0x2a201a, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matCharbon=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:1.0, metalness:0, flatShading:true});
  const matTerre=new THREE.MeshStandardMaterial({color:0x3a2e22, roughness:1.0, metalness:0, flatShading:true});
  const matLamp=new THREE.MeshStandardMaterial({
    color:0xffc878, emissive:new THREE.Color(0xff8a3a), emissiveIntensity:1.0,
    roughness:0.5, metalness:0.3, flatShading:true,
  });

  // TERRIL principal (noir, plus haut, à l'arrière)
  const terril=new THREE.Mesh(new THREE.ConeGeometry(6.5, 7.0, 12), matCharbon);
  terril.position.set(-3, 3.5, -5); terril.castShadow=true; terril.receiveShadow=true;
  g.add(terril);
  // terril secondaire (plus petit, à l'avant droit)
  const terril2=new THREE.Mesh(new THREE.ConeGeometry(3.0, 2.4, 10), matCharbon);
  terril2.position.set(6.5, 1.2, 3); terril2.receiveShadow=true; g.add(terril2);
  // amas de terre / déchets
  const tas=new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.6, 8), matTerre);
  tas.position.set(4.5, 0.8, -1); g.add(tas);

  // CHEVALEMENT (headframe) — structure bois/fer à 4 montants + molette
  const HF_H=10.5;   // hauteur totale
  const HF_W=4.0;    // emprise au sol
  const hf=new THREE.Group();
  // base maçonnée (le chevalement « tient » au sol)
  hf.add(_M5_box(4.6, 1.0, 4.6, matBoisFonce, 0, 0.5, 0));
  // 4 montants verticaux + 4 montants inclinés arrière
  for(const [sx, sz] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
    const m=new THREE.Mesh(new THREE.BoxGeometry(0.28, HF_H, 0.28), matBois);
    m.position.set(sx*HF_W/2, HF_H/2 + 1.0, sz*HF_W/2);
    m.castShadow=true; hf.add(m);
  }
  // contreventement diagonal (X) sur 2 faces
  for(const sz of [-1, 1]){
    const fz=sz*HF_W/2 + 0.04*sz;
    const L=Math.hypot(HF_W, HF_H);
    for(const sign of [-1, 1]){
      const d=new THREE.Mesh(new THREE.BoxGeometry(0.18, L*0.95, 0.18), matBois);
      d.rotation.z=sign*Math.atan2(HF_W, HF_H);
      d.position.set(0, HF_H/2 + 1.0, fz);
      hf.add(d);
    }
  }
  for(const sx of [-1, 1]){
    const fx=sx*HF_W/2 + 0.04*sx;
    const L=Math.hypot(HF_W, HF_H);
    for(const sign of [-1, 1]){
      const d=new THREE.Mesh(new THREE.BoxGeometry(0.18, L*0.95, 0.18), matBois);
      d.rotation.x=sign*Math.atan2(HF_W, HF_H);
      d.position.set(fx, HF_H/2 + 1.0, 0);
      hf.add(d);
    }
  }
  // poutres horizontales (3 niveaux)
  for(const y of [3.5, 6.5, 9.5]){
    for(const sz of [-1, 1]){
      hf.add(_M5_box(HF_W, 0.20, 0.20, matBois, 0, y + 1.0, sz*HF_W/2));
    }
    for(const sx of [-1, 1]){
      hf.add(_M5_box(0.20, 0.20, HF_W, matBois, sx*HF_W/2, y + 1.0, 0));
    }
  }
  // sommet : petit toit en tôle pour fermer le volume
  hf.add(_M5_box(HF_W + 0.6, 0.18, HF_W + 0.6, matFer, 0, HF_H + 1.05, 0));
  // MOLETTE (roue à câble) — 2 roues côte à côte au sommet
  for(const sz of [-1, 1]){
    const wheel=new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.12, 6, 16), matFer);
    wheel.rotation.y=Math.PI/2;
    wheel.position.set(0, HF_H + 0.5, sz*0.9);
    hf.add(wheel);
    // rayons (4 par roue)
    for(let i=0;i<4;i++){
      const r=new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.5, 0.08), matFer);
      r.rotation.x=i*Math.PI/4;
      r.rotation.y=Math.PI/2;
      r.position.set(0, HF_H + 0.5, sz*0.9);
      hf.add(r);
    }
  }
  // câbles descendant vers l'entrée
  for(const sz of [-1, 1]){
    const cable=new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 9.5, 4), matFer);
    cable.position.set(0, HF_H/2 - 3.5 + 1.0, sz*0.9);
    hf.add(cable);
  }
  hf.position.set(0, 0, 1);
  g.add(hf);

  // ENTRÉE DE GALERIE étayée — encadrement de gros bois + chevron + intérieur très sombre
  // pied droits + linteau + poteau central
  for(const sx of [-1, 1])
    g.add(_M5_box(0.40, 3.2, 0.40, matBois, sx*1.6, 1.6, 4.95));
  g.add(_M5_box(3.6, 0.40, 0.40, matBois, 0, 3.20, 4.95));
  // chevron triangle (linteau renforcé)
  const lintShape=new THREE.Shape();
  lintShape.moveTo(-1.8, 0); lintShape.lineTo(1.8, 0);
  lintShape.lineTo(0, 0.8); lintShape.lineTo(-1.8, 0);
  const lintGeo=new THREE.ExtrudeGeometry(lintShape, {depth: 0.30, bevelEnabled:false});
  const lint=new THREE.Mesh(lintGeo, matBois);
  lint.position.set(0, 3.40, 4.80); g.add(lint);
  // intérieur de la galerie : box sombre encastré (effet bouche d'ombre)
  g.add(_M5_box(2.8, 2.4, 1.6, matCharbon, 0, 1.3, 4.10));
  // 2 lampes de mineur à l'entrée (émissives faibles)
  for(const sx of [-1, 1]){
    const lamp=new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), matLamp);
    lamp.position.set(sx*1.4, 2.0, 4.85); g.add(lamp);
    // potence
    g.add(_M5_box(0.06, 0.30, 0.06, matFer, sx*1.4, 2.18, 4.85));
  }

  // RAILS + WAGONNETS (sortant de la galerie vers le sud)
  for(const dz of [4.6, 5.6, 6.6, 7.6, 8.6]){
    g.add(_M5_box(2.6, 0.10, 0.12, matFer, 0, 0.10, dz));
  }
  // 2 rails parallèles
  g.add(_M5_box(0.10, 0.08, 5.0, matFer, -1.0, 0.16, 6.5));
  g.add(_M5_box(0.10, 0.08, 5.0, matFer, 1.0, 0.16, 6.5));
  // wagonnets
  const wagon=(z)=>{
    g.add(_M5_box(2.0, 1.0, 1.5, matBoisFonce, 0, 0.7, z));
    g.add(_M5_box(2.1, 0.4, 1.6, matCharbon, 0, 1.3, z));
    // roues
    for(const sx of [-1, 1])
      for(const sz2 of [-0.5, 0.5]){
        const wh=new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8), matFer);
        wh.rotation.z=Math.PI/2;
        wh.position.set(sx*0.9, 0.30, z + sz2); g.add(wh);
      }
    // attelage avant
    g.add(_M5_box(0.10, 0.10, 0.30, matFer, 0, 0.55, z - 0.85));
  };
  wagon(5.8); wagon(7.8);
  // tas de charbon dans l'un des wagonnets (déjà couvert via boxe sombre)

  // BARAQUE DE GARDE (petit volume CLOS à côté)
  const bar=new THREE.Group();
  // soubassement
  bar.add(_M5_box(2.4, 0.18, 2.0, matTerre, 0, 0.09, 0));
  // corps
  bar.add(_M5_box(2.2, 1.8, 1.8, matBoisFonce, 0, 1.0, 0));
  // toit pitched fermé
  const barRoof=_M6_pitchedClosed(2.2, 1.8, 0.55, matFer, matBois);
  barRoof.position.y=1.90; bar.add(barRoof);
  // porte
  bar.add(_M5_box(0.7, 1.4, 0.06, matBoisFonce, 0, 0.7, 0.93));
  bar.position.set(-6, 0, 4);
  g.add(bar);

  // QUELQUES MORCEAUX DE CHARBON éparpillés au sol
  for(let i=0;i<5;i++){
    const px=2 + Math.random()*3, pz=1 + Math.random()*4;
    g.add(_M5_box(0.3 + Math.random()*0.4, 0.18 + Math.random()*0.20, 0.3 + Math.random()*0.4,
      matCharbon, px, 0.10, pz));
  }
}

// helper interne M6 — box() retourne un Mesh ; on fixe son material partagé et la position.
function _M5_box(w, h, d, mat, x, y, z, castShadow=true){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow=castShadow; m.receiveShadow=true;
  return m;
}
function buildPort(g){                // PORT — quai planches, grue à vapeur, navire, marchandises d'époque
  // matières
  const planches=planchesTexture();
  const matPlanches=new THREE.MeshStandardMaterial({
    color:0x8a7058, map:planches.map, roughnessMap:planches.roughnessMap,
    roughness:0.95, metalness:0,
  });
  const matCoque=new THREE.MeshStandardMaterial({color:0x2a2418, roughness:0.85, metalness:0.1, flatShading:true});
  const matCoqueClaire=new THREE.MeshStandardMaterial({color:0x4a3f2e, roughness:0.9, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  const matBois=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
  const matCharbon=new THREE.MeshStandardMaterial({color:0x2a2620, roughness:1.0, metalness:0, flatShading:true});
  const matFanal=new THREE.MeshStandardMaterial({
    color:0xffd9a4, emissive:new THREE.Color(0xffb45e), emissiveIntensity:1.5,
    roughness:0.5, metalness:0.3, flatShading:true,
  });
  const matSail=new THREE.MeshStandardMaterial({color:0xb8a878, roughness:0.95, metalness:0, side:THREE.DoubleSide, flatShading:true});

  // QUAI — pont en planches large, posé sur poutres maçonnées
  // empreinte du quai : 22×7 (légèrement plus large que l'ancien 20×7)
  const quaiPlanches=planchesTexture();
  quaiPlanches.map.repeat.set(3, 1.2); quaiPlanches.roughnessMap.repeat.set(3, 1.2);
  const matQuai=new THREE.MeshStandardMaterial({
    color:0x8a7058, map:quaiPlanches.map, roughnessMap:quaiPlanches.roughnessMap,
    roughness:0.95, metalness:0,
  });
  const quai=new THREE.Mesh(new THREE.BoxGeometry(22, 0.75, 7), matQuai);
  quai.position.set(-2, 0.375, -5); quai.receiveShadow=true; quai.castShadow=true;
  g.add(quai);
  // poteaux/poutres maçonnés sous le quai (5 piles visibles côté mer)
  for(let i=0; i<5; i++){
    g.add(_M5_box(0.5, 1.0, 0.5, matCharbon, -12 + i*4.5, 0.0, -8.0));
  }
  // bord en pierre côté terre (transition vers le sol)
  g.add(_M5_box(22, 0.30, 0.45, matCharbon, -2, 0.15, -1.6));

  // BITTES D'AMARRAGE (6 le long du bord du quai, côté mer)
  for(let i=0; i<6; i++){
    const bx=-11 + i*3.6;
    const bitte=new THREE.Group();
    // cylindre principal
    const cyl=new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 0.85, 8), matFer);
    cyl.position.y=0.425; bitte.add(cyl);
    // chapeau bombé
    const cap=new THREE.Mesh(new THREE.SphereGeometry(0.20, 8, 6), matFer);
    cap.position.y=0.85; bitte.add(cap);
    bitte.position.set(bx, 0.75, -7.5);
    g.add(bitte);
  }

  // GRUE À VAPEUR pivotante — base + colonne + bras articulé
  const grue=new THREE.Group();
  grue.userData.crane=true;   // pour animation lente de pivot
  // base maçonnée
  grue.add(_M5_box(2.4, 0.8, 2.4, matCharbon, 0, 0.4, 0));
  // socle métal
  grue.add(_M5_box(2.0, 0.30, 2.0, matFer, 0, 0.95, 0));
  // partie pivotante (tout le groupe au-dessus)
  const pivot=new THREE.Group();
  pivot.userData.pivot=true;
  // mât / colonne
  pivot.add(_M5_box(0.55, 5.0, 0.55, matFer, 0, 2.50 + 1.10, 0));
  // chaudière (cabine cylindrique)
  const chau=new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.6, 12), matFer);
  chau.position.set(-0.6, 1.95, 0.95); pivot.add(chau);
  // cheminée de la chaudière
  const stack=new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.8, 8), matCharbon);
  stack.position.set(-0.6, 3.55, 0.95); pivot.add(stack);
  // émetteur de fumée
  const smoke=new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8),
    new THREE.MeshStandardMaterial({color:0x8a8275, transparent:true, opacity:0.3, flatShading:true}));
  smoke.position.set(-0.6, 4.55, 0.95); smoke.userData.chimney=true; pivot.add(smoke);
  // bras (flèche) qui s'incline ~30°
  const arm=new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.35, 0.35), matFer);
  arm.position.set(2.4, 5.20, 0);
  arm.rotation.z=-0.28;
  pivot.add(arm);
  // tirant arrière (haubanage)
  const ten=new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.10, 0.10), matFer);
  ten.position.set(-1.0, 5.20, 0);
  ten.rotation.z=0.55;
  pivot.add(ten);
  // câble + crochet pendant
  const cable=new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.6, 4), matFer);
  cable.position.set(5.4, 3.4, 0); pivot.add(cable);
  const hook=new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.05, 4, 8), matFer);
  hook.rotation.x=Math.PI/2;
  hook.position.set(5.4, 1.55, 0); pivot.add(hook);
  // câble vertical raide près du mât
  pivot.add(_M5_box(0.05, 5.0, 0.05, matFer, 0.3, 3.6, 0));
  grue.add(pivot);
  grue.position.set(-9, 0.75, -4);
  g.add(grue);
  _M6_cranes.push(pivot);

  // NAVIRE À QUAI — coque sombre + pont + mât + voile carguée + fanal
  const ship=new THREE.Group();
  // coque (BoxGeometry effilée)
  const hull=new THREE.Mesh(new THREE.BoxGeometry(10.0, 1.8, 3.2), matCoque);
  hull.position.y=1.5; ship.add(hull);
  // proue (triangle qui pointe vers x positif)
  const prowShape=new THREE.Shape();
  prowShape.moveTo(-1.6, -1.6); prowShape.lineTo(0, 0); prowShape.lineTo(-1.6, 1.6); prowShape.lineTo(-1.6, -1.6);
  const prowGeo=new THREE.ExtrudeGeometry(prowShape, {depth: 1.8, bevelEnabled: false});
  prowGeo.translate(0, -0.9, 0);
  const prow=new THREE.Mesh(prowGeo, matCoque);
  prow.rotation.x=Math.PI/2;
  prow.position.set(5.0, 1.5, 0); ship.add(prow);
  // poupe (rectangle simple — coque arrondie suggérée)
  const stern=new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.8, 2.6), matCoque);
  stern.position.set(-5.5, 1.5, 0); ship.add(stern);
  // pont (planches sombres)
  ship.add(_M5_box(10.5, 0.18, 3.0, matCoqueClaire, 0, 2.45, 0, false));
  // BORDS (bastingage)
  ship.add(_M5_box(10.5, 0.50, 0.10, matBois, 0, 2.65, 1.55, false));
  ship.add(_M5_box(10.5, 0.50, 0.10, matBois, 0, 2.65, -1.55, false));
  // CABINE arrière
  ship.add(_M5_box(2.4, 1.6, 2.4, matBois, -3.5, 3.30, 0));
  // toit cabine pitched fermé
  const cabRoof=_M6_pitchedClosed(2.4, 2.4, 0.5, matFer, matBois);
  cabRoof.position.set(-3.5, 4.10, 0); ship.add(cabRoof);
  // 2 hublots cabine
  for(const sz of [-1, 1]){
    const hub=new THREE.Mesh(new THREE.CircleGeometry(0.18, 12),
      new THREE.MeshStandardMaterial({color:0x33414c, emissive:0xffb45e, emissiveIntensity:0.5, flatShading:true}));
    hub.position.set(-3.5, 3.40, sz*1.21); hub.rotation.y=sz>0 ? 0 : Math.PI;
    ship.add(hub);
  }
  // MÂT principal + verges + voile carguée
  ship.add(_M5_box(0.30, 7.5, 0.30, matBois, 1.5, 6.20, 0));
  // 2 verges (croix horizontales)
  for(const y of [5.5, 8.2]){
    ship.add(_M5_box(0.10, 0.10, 3.6, matBois, 1.5, y, 0));
  }
  // voile carguée (paquet rectangulaire au mât)
  const sail=new THREE.Mesh(new THREE.BoxGeometry(0.20, 1.4, 2.6), matSail);
  sail.position.set(1.5, 6.6, 0); ship.add(sail);
  // FANAL au sommet du mât (émissif gasLight)
  const fanal=new THREE.Mesh(new THREE.SphereGeometry(0.20, 8, 8), matFanal);
  fanal.position.set(1.5, 9.50, 0); ship.add(fanal);
  // potence + cage du fanal
  ship.add(_M5_box(0.06, 0.40, 0.06, matFer, 1.5, 9.20, 0, false));
  // ANCRE pendant à la proue
  ship.add(_M5_box(0.10, 0.80, 0.10, matFer, 4.0, 1.20, 1.30, false));
  ship.add(_M5_box(0.55, 0.20, 0.10, matFer, 4.0, 0.80, 1.30, false));
  ship.position.set(4, 0, 9);
  g.add(ship);

  // MARCHANDISES SUR LE QUAI — balles, tonneaux, caisses (PAS de containers)
  // pile de tonneaux côté gauche
  for(let i=0; i<3; i++){
    const barrel=createBarrel(0x6b4a2c);
    barrel.position.set(-9 + i*1.3, 0.75, -5.5);
    g.add(barrel);
  }
  // tonneaux empilés (rangée du dessus)
  for(let i=0; i<2; i++){
    const barrel=createBarrel(0x6b4a2c);
    barrel.position.set(-8.3 + i*1.3, 0.75 + 1.3, -5.5);
    g.add(barrel);
  }
  // BALLES de marchandises (coton/laine) — sacs ronds
  for(let i=0; i<4; i++){
    const sack=createSack(i%2 ? 0xc9b78c : 0xbfa97e);
    sack.position.set(-1 + i*1.5, 0.75, -5.8);
    g.add(sack);
  }
  // caisses empilées côté droit
  for(const [x, z, y] of [[5, -5, 0.75], [5, -3.5, 0.75], [5, -5, 0.75+1.4], [6.4, -4, 0.75]]){
    const crate=createCrate(1.3, 0x8a5a3e);
    crate.position.set(x, y, z);
    g.add(crate);
  }
  // tas de charbon devant le navire
  const coalPile=createCoalPile();
  coalPile.position.set(-3, 0.75, -5.8); g.add(coalPile);

  // BORNES DE FORÇAGE / cabestans (petits cylindres décoratifs)
  for(let i=0; i<2; i++){
    g.add(_M5_box(0.40, 1.0, 0.40, matBois, -2 + i*5, 1.25, -3.6));
  }
}
const _M6_cranes=[];   // grues pivotantes du port
function _M6_updateCranes(){
  for(const c of _M6_cranes) c.rotation.y = Math.sin(t * 0.18) * 0.45;
}

/* =====================================================================
   M-Mer/B — PHARE.
   Tour low-poly à bandes (pierre claire / bande rouge / pierre claire)
   sur un môle au sud du port. Lanterne sommitale émissive (sous le
   seuil bloom) + halo source. Le faisceau tournant a été retiré : la
   silhouette du phare avec sa lanterne suffit à signaler le port.
   ===================================================================== */
let _M_Mer_phareLantern = null; // material émissif (modulation jour/nuit)
let _M_Mer_phareHalo = null;    // sprite halo (modulation jour/nuit)
function buildLighthouse(){
  // Position : môle pierre au SUD du port (x≈109, z=-70). Hors zone d'eau
  //   (eau commence à x≈113) : la base reste sur la terre/jetée pierre.
  const baseX = 109, baseZ = -70;
  const root = new THREE.Group();
  root.position.set(baseX, 0, baseZ);
  // --- môle pierre (jetée) ---
  const matStone = new THREE.MeshStandardMaterial({color:0x4a4540, roughness:1.0, metalness:0.0, flatShading:true});
  const matStoneLight = new THREE.MeshStandardMaterial({color:0xb8a890, roughness:0.85, metalness:0.0, flatShading:true});
  const matStoneDark  = new THREE.MeshStandardMaterial({color:0x2a2620, roughness:1.0, metalness:0.0, flatShading:true});
  const matRed   = new THREE.MeshStandardMaterial({color:0x8a2a1c, roughness:0.9, metalness:0.0, flatShading:true});
  const matBlack = new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.55, metalness:0.6, flatShading:true});
  const jetee = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.6, 4.5), matStone);
  jetee.position.set(0.6, 0.30, 0);            // déborde légèrement vers l'eau (+x)
  jetee.castShadow = true; jetee.receiveShadow = true;
  root.add(jetee);
  // socle circulaire pierre (transition jetée → tour)
  const socle = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.85, 1.2, 12), matStone);
  socle.position.set(0, 1.2, 0);
  socle.castShadow = true; root.add(socle);
  // --- tour : 3 anneaux alternés (stone clair / blanc / stone clair) ---
  const towerY0 = 1.8;
  const ringH = 2.3;
  const ringR = 1.20;
  const rings = [matStoneLight, matRed, matStoneLight];
  for(let i=0; i<3; i++){
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(ringR - i*0.08, ringR - i*0.06, ringH, 14), rings[i]);
    seg.position.set(0, towerY0 + i*ringH + ringH/2, 0);
    seg.castShadow = true; root.add(seg);
  }
  // coursive (anneau d'observation sous la lanterne)
  const coursH = 0.25;
  const cours = new THREE.Mesh(new THREE.TorusGeometry(ringR + 0.18, 0.08, 6, 16), matBlack);
  cours.rotation.x = Math.PI/2;
  cours.position.set(0, towerY0 + 3*ringH + coursH/2, 0);
  root.add(cours);
  // plancher coursive (disque mince)
  const coursDeck = new THREE.Mesh(new THREE.CylinderGeometry(ringR + 0.22, ringR + 0.22, coursH, 14), matStoneDark);
  coursDeck.position.set(0, towerY0 + 3*ringH + coursH/2, 0);
  root.add(coursDeck);
  // --- lanterne (volume vitré + halo émissif) ---
  const lantY = towerY0 + 3*ringH + coursH + 0.6;
  const lantMat = new THREE.MeshStandardMaterial({
    color:0xffe2a8, emissive:new THREE.Color(0xffb45e), emissiveIntensity:0.0,
    roughness:0.30, metalness:0.20, flatShading:true,
  });
  _M_Mer_phareLantern = lantMat;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 1.20, 12), lantMat);
  lantern.position.set(0, lantY, 0);
  root.add(lantern);
  // cage métal autour de la lanterne (6 montants verticaux)
  for(let i=0; i<6; i++){
    const a = (i/6) * Math.PI*2;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.20, 0.07), matBlack);
    post.position.set(Math.cos(a)*0.92, lantY, Math.sin(a)*0.92);
    root.add(post);
  }
  // toit conique
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.10, 1.10, 12), matBlack);
  roof.position.set(0, lantY + 0.60 + 0.55, 0);
  root.add(roof);
  // pointe (épi)
  const epi = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, 0.70, 6), matBlack);
  epi.position.set(0, lantY + 0.60 + 1.10 + 0.35, 0);
  root.add(epi);

  // --- halo source (sprite additif au niveau lanterne) ---
  const haloCv = document.createElement('canvas'); haloCv.width=haloCv.height=128;
  const hctx = haloCv.getContext('2d');
  const hg = hctx.createRadialGradient(64,64,2,64,64,62);
  hg.addColorStop(0,'rgba(255,230,180,0.95)');
  hg.addColorStop(0.4,'rgba(255,180,100,0.40)');
  hg.addColorStop(1,'rgba(255,160,80,0)');
  hctx.fillStyle=hg; hctx.fillRect(0,0,128,128);
  const haloTex = new THREE.CanvasTexture(haloCv);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, color: 0xffd8a8, transparent: true, opacity: 0.0,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  halo.scale.set(3.5, 3.5, 1);
  halo.position.set(0, lantY, 0);
  root.add(halo);
  _M_Mer_phareHalo = halo;

  scene.add(root);

  // barrière invisible : on n'entre pas dans le môle
  obstacles.push({pos:new THREE.Vector2(baseX, baseZ), radius:3.5});
}
/* M-Mer/correctif-rivage — ÉCUME DU RESSAC.
   Petits patches additifs placés sur la LIGNE DE MARÉE (intersection
   estran ↔ surface d'eau). Position en z répartie sur toute la côte,
   x calculé via la même fonction _M_Mer_shoreNoise → aligne exactement
   sur la ligne de marée du mesh estran. Opacité pulsée (ressac doux)
   et léger va-et-vient horizontal. Texture canvas additive, sous le
   seuil de bloom. */
let _M_Mer_shoreFoam = null;
function _M_Mer_buildShoreFoam(){
  // texture : bande horizontale + grains blancs
  const cv = document.createElement('canvas'); cv.width=128; cv.height=24;
  const x = cv.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 24);
  g.addColorStop(0,'rgba(255,255,255,0)');
  g.addColorStop(0.5,'rgba(245,250,255,0.80)');
  g.addColorStop(1,'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0,0,128,24);
  x.fillStyle = 'rgba(255,255,255,0.85)';
  for(let i=0;i<60;i++){
    x.fillRect(Math.random()*128, 6 + Math.random()*12, 1+Math.random()*2, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  // patches : ~48 patches répartis sur z ∈ [-130, 130]
  const N = 48;
  const dZ = 260;
  _M_Mer_shoreFoam = [];
  for(let i=0; i<N; i++){
    const z = -dZ/2 + (i/N)*dZ + (Math.random()-0.5)*1.6;
    // la ligne de marée tombe à tt ≈ 0.16 sur l'estran (cf. _M6_buildEstran).
    //   xLand + 0.16*(xWater-xLand) = 107 + n0*1.6 + 0.16*(8.5 + (n1-n0)*1.5)
    //   approx : x_shore(z) ≈ 108.4 + _M_Mer_shoreNoise(z, 0)*1.4
    const xShore = 108.4 + _M_Mer_shoreNoise(z, 0.0) * 1.4;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(6.5, 1.1),
      new THREE.MeshBasicMaterial({
        map: tex, color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
      }),
    );
    m.rotation.x = -Math.PI/2;
    m.position.set(xShore, 0.025, z);
    m.userData.baseX = xShore;
    m.userData.phase = Math.random() * 6.28;
    scene.add(m);
    _M_Mer_shoreFoam.push(m);
  }
}
function _M_Mer_updateShoreFoam(){
  if(!_M_Mer_shoreFoam) return;
  for(const m of _M_Mer_shoreFoam){
    const ph = m.userData.phase;
    // ressac : opacité oscille 0 → 0.55 → 0, en saccades douces
    const pulse = 0.35 + 0.42 * Math.sin(t * 1.3 + ph);
    m.material.opacity = Math.max(0, pulse);
    // léger va-et-vient horizontal (±0.55 m)
    m.position.x = m.userData.baseX + Math.sin(t * 0.7 + ph * 0.7) * 0.55;
  }
}

function _M_Mer_updateLighthouse(){
  if(!_M_Mer_phareLantern) return;
  // intensité jour/nuit : kNight pilote (kDay≈0 nuit ; on veut l'inverse).
  const kNight = (typeof DayCycle!=='undefined' && typeof DayCycle.kDay==='number')
    ? Math.max(0, Math.min(1, 1 - DayCycle.kDay)) : 0.5;
  // émissive lanterne : sous le seuil bloom même la nuit (intensité 0.75 max,
  //   couleur déjà gasLight chaude — luminance ~0.7).
  _M_Mer_phareLantern.emissiveIntensity = 0.10 + 0.65 * kNight;
  if(_M_Mer_phareHalo){
    // halo source : pulse doux à peine perceptible
    const pulse = 0.92 + 0.08 * Math.sin(t * 2.1);
    _M_Mer_phareHalo.material.opacity = (0.10 + 0.45 * kNight) * pulse;
  }
}

/* =====================================================================
   M-Mer/C — BATEAUX ANIMÉS.
   3 embarcations qui patrouillent la mer : 2 voiliers sur boucles
   fermées, 1 vapeur cargo sur ligne nord-sud avec cheminée fumante.
   Chacun a un PATH (waypoints), une vitesse et un sillage (trail de
   plans semi-transparents qui se réinjectent par anneau circulaire,
   coût constant).
   ===================================================================== */
const _M_Mer_traffic = [];          // {obj, path, p, speed, tangage, smokeStack, wake, isSteamer}

function _M_Mer_createSteamer(){
  // Petit vapeur cargo d'époque : coque plus longue, cabine arrière,
  //   cheminée fumante au centre, cale ouverte au pont avant.
  const g = new THREE.Group();
  const matCoque   = new THREE.MeshStandardMaterial({color:0x3a2f24, roughness:0.85, metalness:0.05, flatShading:true});
  const matCoqueB  = new THREE.MeshStandardMaterial({color:0x1a1612, roughness:0.95, metalness:0.05, flatShading:true});
  const matPont    = new THREE.MeshStandardMaterial({color:0x6a5840, roughness:0.95, metalness:0.0,  flatShading:true});
  const matCabine  = new THREE.MeshStandardMaterial({color:0x8a7a56, roughness:0.85, metalness:0.0,  flatShading:true});
  const matToit    = new THREE.MeshStandardMaterial({color:0x4a2618, roughness:0.85, metalness:0.0,  flatShading:true});
  const matMetal   = new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5,  metalness:0.7,  flatShading:true});
  const matFanal   = new THREE.MeshStandardMaterial({
    color:0xffd9a4, emissive:new THREE.Color(0xffb45e), emissiveIntensity:0.30,
    roughness:0.5, metalness:0.3, flatShading:true,
  });
  // coque
  const coque = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.0, 8.5), matCoque);
  coque.position.y = 0.50; g.add(coque);
  // bande sombre en bas
  g.add((m=>{ m.position.set(0, 0.10, 0); return m; })(new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.20, 8.5), matCoqueB)));
  // proue effilée
  const proue = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.4, 6), matCoque);
  proue.rotation.x = Math.PI/2;
  proue.rotation.z = Math.PI;
  proue.position.set(0, 0.50, 4.95); g.add(proue);
  // pont
  const pont = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 8.0), matPont);
  pont.position.y = 1.05; g.add(pont);
  // cale ouverte (rectangle creusé) avant — simple cube sombre dessous
  const cale = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.10, 2.4), matCoqueB);
  cale.position.set(0, 1.05, 2.4); g.add(cale);
  // cabine arrière (timonerie)
  const cabine = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 2.2), matCabine);
  cabine.position.set(0, 1.65, -2.4); g.add(cabine);
  const toit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 2.4), matToit);
  toit.position.set(0, 2.20, -2.4); g.add(toit);
  // mât bas
  const mat = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), matMetal);
  mat.position.set(0, 2.5, 1.5); g.add(mat);
  // cheminée (centre coque)
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.9, 8), matCoqueB);
  stack.position.set(0, 2.35, -0.6); g.add(stack);
  // anneau métal en haut cheminée
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.06, 4, 8), matMetal);
  ring.rotation.x = Math.PI/2; ring.position.set(0, 3.20, -0.6); g.add(ring);
  // fanal arrière (petit globe émissif sous le seuil bloom)
  const fanal = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 6), matFanal);
  fanal.position.set(0, 2.60, -3.5); g.add(fanal);
  // tag : la cheminée est le point d'ancrage de la fumée
  g.userData.stackPos = new THREE.Vector3(0, 3.20, -0.6);
  return g;
}

function _M_Mer_buildWakeTrail(parent){
  // Sillage : 8 plans semi-transparents disposés derrière le bateau, l'un
  //   après l'autre. Chaque plan vit dans le repère MONDE (pas dans le
  //   bateau) : on les réinjecte derrière le bateau à intervalle régulier.
  const trail = [];
  const tex = (() => {
    const c = document.createElement('canvas'); c.width=64; c.height=32;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0,0,64,0);
    g.addColorStop(0,'rgba(255,255,255,0)');
    g.addColorStop(0.4,'rgba(240,240,240,0.55)');
    g.addColorStop(1,'rgba(220,220,220,0)');
    x.fillStyle = g; x.fillRect(0,0,64,32);
    return new THREE.CanvasTexture(c);
  })();
  for(let i=0; i<8; i++){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.5),
      new THREE.MeshBasicMaterial({map:tex, transparent:true, opacity:0,
        depthWrite:false, fog:true}));
    m.rotation.x = -Math.PI/2;
    m.position.y = 0.05;
    scene.add(m);
    trail.push({obj:m, age: 1});
  }
  return trail;
}

function _M_Mer_buildSmokeStack(boat){
  // Panache de fumée d'un vapeur : 5 sprites montant + dérivant à l'est.
  const tex = _smokeTexture();   // partagé avec la skyline (déjà créé)
  const puffs = [];
  for(let i=0; i<5; i++){
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0x6a6660, transparent: true, opacity: 0,
      depthWrite: false, fog: true,
    }));
    sp.scale.set(2.0, 2.0, 1);
    scene.add(sp);
    puffs.push({obj: sp, phase: i/5, age: i/5});
  }
  return puffs;
}

function buildMaritimeTraffic(){
  // 3 trajectoires : 2 voiliers en boucle, 1 vapeur en aller-retour N-S.
  const paths = [
    // voilier 1 — boucle large autour du large
    { kind:'voilier', speed:1.6, path:[
      [150, 0,  90], [200, 0,  60], [230, 0,   0], [220, 0, -70],
      [180, 0,-120], [140, 0,-100], [125, 0, -40], [130, 0,  40],
    ]},
    // voilier 2 — boucle plus rapprochée, sens contraire
    { kind:'voilier', speed:1.1, path:[
      [140, 0,-150], [175, 0,-180], [205, 0,-150], [215, 0, -90],
      [195, 0, -30], [160, 0,   0], [135, 0, -50], [128, 0,-110],
    ]},
    // vapeur — ligne N-S, aller-retour
    { kind:'steamer', speed:2.2, path:[
      [165, 0, -180], [175, 0,  -90], [180, 0,   0], [175, 0,  90], [165, 0, 180],
      [160, 0, 90],  [158, 0,   0], [160, 0, -90],   // retour pour fermer la boucle
    ]},
  ];
  for(let i=0; i<paths.length; i++){
    const cfg = paths[i];
    const obj = (cfg.kind === 'steamer') ? _M_Mer_createSteamer() : createBoat();
    scene.add(obj);
    const trail = _M_Mer_buildWakeTrail(obj);
    const smoke = (cfg.kind === 'steamer') ? _M_Mer_buildSmokeStack(obj) : null;
    _M_Mer_traffic.push({
      obj, kind: cfg.kind, path: cfg.path, p: Math.random(), speed: cfg.speed,
      trail, trailIdx: 0, trailTimer: 0,
      smoke, smokeTimer: 0,
      tangagePhase: Math.random()*6.28,
    });
  }
}

/* =====================================================================
   M-Mer/D — FAUNE & DÉTAILS.
   - Crabes : 4-5 figurines low-poly sur l'estran, marche latérale
     (déplacement perpendiculaire à l'orientation), pauses aléatoires.
   - Mouettes : 4 sprites qui planent au-dessus de la mer (orbites
     basses), parfois posées sur les bittes du quai (statique).
   - Bouées : 3 sphères rouges/blanches ballottées au large.
   - Banc de poissons : reflet argenté furtif sous la surface, scintille
     par à-coups (sprite additif court).
   ===================================================================== */
const _M_Mer_crabs = [];     // {obj, baseX, baseZ, dirZ, speed, pauseT, walkPhase}
const _M_Mer_gulls = [];     // {obj, cx, cz, r, y, a, v, ph}
const _M_Mer_buoys = [];     // {obj, baseX, baseZ, phase}
const _M_Mer_fishGlints = [];// {obj, baseX, baseZ, life}

function _M_Mer_createCrab(){
  // Low-poly : corps ovale plat, 2 yeux, 2 pinces, 8 pattes (2 fines barres).
  const g = new THREE.Group();
  const matCarap = new THREE.MeshStandardMaterial({color:0x7a2a1c, roughness:0.9, metalness:0.0, flatShading:true});
  const matCarapD= new THREE.MeshStandardMaterial({color:0x4a1810, roughness:0.95, metalness:0.0, flatShading:true});
  const matOeil  = new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.0, flatShading:true});
  // carapace (sphère écrasée)
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), matCarap);
  body.scale.set(1.15, 0.45, 1.0);
  body.position.y = 0.15; g.add(body);
  // sous-ventre
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.10, 0.36), matCarapD);
  belly.position.y = 0.06; g.add(belly);
  // 2 yeux sur tiges
  for(const sx of [-0.10, 0.10]){
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.10, 4), matCarapD);
    stem.position.set(sx, 0.27, 0.18); g.add(stem);
    const oeil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), matOeil);
    oeil.position.set(sx, 0.34, 0.20); g.add(oeil);
  }
  // 2 pinces (boxes)
  for(const sx of [-0.30, 0.30]){
    const pince = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.18), matCarap);
    pince.position.set(sx, 0.13, 0.16); g.add(pince);
  }
  // pattes (barres fines, 4 par côté représentées par 2 box plats)
  for(const sx of [-1, 1]){
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.04), matCarapD);
    leg.position.set(sx*0.28, 0.08, 0); g.add(leg);
    const leg2 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.04), matCarapD);
    leg2.position.set(sx*0.26, 0.08, -0.12); g.add(leg2);
  }
  return g;
}

function _M_Mer_createGull(){
  // Mouette : silhouette en V (2 ailes), corps blanc cassé.
  const g = new THREE.Group();
  const matCorps = new THREE.MeshStandardMaterial({color:0xe8e2d0, roughness:0.9, metalness:0.0, flatShading:true});
  const matAile  = new THREE.MeshStandardMaterial({color:0xc8b8a0, roughness:0.95, metalness:0.0, flatShading:true});
  const corps = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.10, 0.55), matCorps);
  g.add(corps);
  const w1 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.22), matAile);
  w1.position.set(-0.52, 0.02, 0); g.add(w1);
  const w2 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.22), matAile);
  w2.position.set( 0.52, 0.02, 0); g.add(w2);
  g.userData.w1 = w1; g.userData.w2 = w2;
  return g;
}

function _M_Mer_createBuoy(){
  // Bouée : sphère rouge en haut + cylindre blanc bande + ancrage
  const g = new THREE.Group();
  const matRouge = new THREE.MeshStandardMaterial({color:0x8a2a1c, roughness:0.85, metalness:0.05, flatShading:true});
  const matBlanc = new THREE.MeshStandardMaterial({color:0xe0d8c4, roughness:0.95, metalness:0.0, flatShading:true});
  const matMetal = new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.6, flatShading:true});
  const haut = new THREE.Mesh(new THREE.SphereGeometry(0.30, 8, 6), matRouge);
  haut.position.y = 0.50; g.add(haut);
  const corps = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.30, 0.45, 8), matBlanc);
  corps.position.y = 0.22; g.add(corps);
  // ceinture
  const cein = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.04, 4, 10), matMetal);
  cein.rotation.x = Math.PI/2; cein.position.y = 0.22; g.add(cein);
  return g;
}

function buildSeaFauna(){
  // --- CRABES sur l'estran (x ≈ 109-112 selon noiseEstran). 5 emplacements
  //   dispersés en z, hors voie principale du port.
  const crabSpots = [
    [110.0,  35], [110.5,  18], [109.8, -20], [110.2, -55], [111.0,  62],
  ];
  for(const [bx, bz] of crabSpots){
    const c = _M_Mer_createCrab();
    c.position.set(bx, 0.02, bz);
    scene.add(c);
    _M_Mer_crabs.push({
      obj: c, baseX: bx, baseZ: bz,
      dirZ: (Math.random() < 0.5 ? 1 : -1),
      speed: 0.22 + Math.random()*0.20,
      pauseT: Math.random() * 4,
      walkPhase: Math.random() * 6.28,
    });
  }
  // --- MOUETTES qui planent au-dessus de la mer (4 orbites basses)
  for(let i=0; i<4; i++){
    const g = _M_Mer_createGull();
    scene.add(g);
    _M_Mer_gulls.push({
      obj: g,
      cx: 150 + Math.random()*60,         // centre orbite à l'est
      cz: -80 + Math.random()*160,
      r: 14 + Math.random()*12,
      y: 9 + Math.random()*6,
      a: Math.random() * 6.28,
      v: 0.32 + Math.random()*0.18,
      ph: Math.random() * 6.28,
    });
  }
  // 2 mouettes posées sur les bittes du quai (statiques, légèrement
  //   tournées). Bittes : world (-2 + i*3.6, 0.75, -7.5) pour i ∈ {0..5}
  //   → port zone center (102, 2) → world x = 100 + i*3.6, z = -5.5
  for(const [bxw, bzw, ry] of [[103.6, -5.5, -0.6], [107.2, -5.5, 0.4]]){
    const g = _M_Mer_createGull();
    g.position.set(bxw, 1.5, bzw);
    g.rotation.y = ry;
    g.scale.set(0.85, 0.85, 0.85);
    scene.add(g);
    // pas d'entrée dans _M_Mer_gulls (mouette posée, on n'anime pas)
  }
  // --- BOUÉES flottantes au large (3 positions calmes, ballottement)
  const buoySpots = [
    [128, 22], [135, -36], [142, 60],
  ];
  for(const [bx, bz] of buoySpots){
    const b = _M_Mer_createBuoy();
    b.position.set(bx, 0, bz);
    scene.add(b);
    _M_Mer_buoys.push({obj: b, baseX: bx, baseZ: bz, phase: Math.random()*6.28});
  }
  // --- BANC DE POISSONS suggéré : 4 sprites argentés furtifs sous la
  //   surface, scintillent par à-coups (vie courte, réapparition aléatoire).
  const glintCv = document.createElement('canvas'); glintCv.width=glintCv.height=64;
  const gctx = glintCv.getContext('2d');
  for(let i=0; i<8; i++){
    const rx = 20 + Math.random()*22, ry = 20 + Math.random()*22;
    gctx.fillStyle = `rgba(220,230,255,${0.20 + Math.random()*0.25})`;
    gctx.fillRect(rx, ry, 2, 6);
  }
  const glintTex = new THREE.CanvasTexture(glintCv);
  for(let i=0; i<4; i++){
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glintTex, color: 0xc8d8ff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    }));
    sp.scale.set(2.5, 2.5, 1);
    scene.add(sp);
    _M_Mer_fishGlints.push({
      obj: sp,
      baseX: 130 + Math.random()*40,
      baseZ: -90 + Math.random()*180,
      life: -Math.random() * 6,    // démarrage décalé
    });
  }
}

function _M_Mer_updateFauna(dt){
  const kd = (typeof DayCycle!=='undefined' && typeof DayCycle.kDay==='number') ? DayCycle.kDay : 1;
  // CRABES : marche latérale (axe Z), pauses ; réoriente vers le sens de marche
  for(const c of _M_Mer_crabs){
    c.pauseT -= dt;
    if(c.pauseT > 0){
      // immobile : oscille à peine, agite les pattes
      c.walkPhase += dt * 4;
      c.obj.position.y = 0.02 + Math.abs(Math.sin(c.walkPhase*0.4)) * 0.005;
    } else {
      c.walkPhase += dt * 8;
      c.obj.position.z += c.dirZ * c.speed * dt;
      // démarche : petit bobbing
      c.obj.position.y = 0.02 + Math.abs(Math.sin(c.walkPhase)) * 0.015;
      // demi-tour aux bornes (±2.2 m de la base)
      const off = c.obj.position.z - c.baseZ;
      if(Math.abs(off) > 2.2){
        c.dirZ *= -1;
        c.pauseT = 1 + Math.random() * 3;
        c.obj.rotation.y = c.dirZ > 0 ? Math.PI/2 : -Math.PI/2;
      }
      // orient : tête vers le sens de marche
      c.obj.rotation.y = c.dirZ > 0 ? Math.PI/2 : -Math.PI/2;
    }
  }
  // MOUETTES en orbite (cachées la nuit)
  for(const g of _M_Mer_gulls){
    g.obj.visible = kd > 0.20;
    if(!g.obj.visible) continue;
    g.a += g.v * dt;
    g.obj.position.set(
      g.cx + Math.cos(g.a)*g.r,
      g.y + Math.sin(t*2 + g.ph) * 0.7,
      g.cz + Math.sin(g.a)*g.r,
    );
    g.obj.rotation.y = -g.a + Math.PI/2;
    const f = Math.sin(t*8 + g.ph) * 0.45;
    if(g.obj.userData.w1){
      g.obj.userData.w1.rotation.z = f;
      g.obj.userData.w2.rotation.z = -f;
    }
  }
  // BOUÉES : ballottement comme les vagues (sinusoïdes sur Y et rotation Z)
  for(const b of _M_Mer_buoys){
    b.obj.position.y = Math.sin(t*1.1 + b.phase) * 0.18;
    b.obj.rotation.z = Math.sin(t*0.9 + b.phase + 0.6) * 0.10;
    b.obj.rotation.x = Math.cos(t*1.05 + b.phase + 1.3) * 0.07;
  }
  // BANC DE POISSONS : scintille par à-coups, vie courte
  for(const f of _M_Mer_fishGlints){
    f.life += dt;
    if(f.life < 0){
      f.obj.material.opacity = 0;
      continue;
    }
    if(f.life > 2.5){
      // disparaît, repositionne et attend
      f.life = -Math.random() * 8 - 2;
      f.baseX = 130 + Math.random()*45;
      f.baseZ = -90 + Math.random()*180;
      f.obj.material.opacity = 0;
      continue;
    }
    f.obj.position.set(f.baseX, 0.015, f.baseZ);
    const a = f.life / 2.5;
    f.obj.material.opacity = Math.sin(a*Math.PI) * 0.42;
    f.obj.scale.set(2.5 + a*1.4, 2.5 + a*1.4, 1);
  }
}

const _M_Mer_pathPos = new THREE.Vector3();
const _M_Mer_pathPosNext = new THREE.Vector3();
function _M_Mer_pathSample(path, t01){
  // Échantillonne une polyligne fermée par t01 ∈ [0,1].
  const n = path.length;
  const tt = t01 * n;
  const i = Math.floor(tt) % n;
  const j = (i + 1) % n;
  const f = tt - Math.floor(tt);
  const a = path[i], b = path[j];
  _M_Mer_pathPos.set(
    a[0] + (b[0]-a[0])*f,
    a[1] + (b[1]-a[1])*f,
    a[2] + (b[2]-a[2])*f,
  );
  _M_Mer_pathPosNext.set(b[0]-a[0], 0, b[2]-a[2]).normalize();
  return _M_Mer_pathPos;
}
function _M_Mer_updateTraffic(dt){
  if(!_M_Mer_traffic.length) return;
  for(const b of _M_Mer_traffic){
    // distance parcourue (longueur estimée du path : on simplifie en disant
    //   qu'une boucle complète ≈ 800 unités → vitesse 1.0 = 1/800 par s).
    b.p = (b.p + dt * b.speed / 800) % 1;
    const pos = _M_Mer_pathSample(b.path, b.p);
    // tangage / roulis selon les vagues : sin sur Y, sin sur Z (roulis)
    const ph = b.tangagePhase;
    const tang = Math.sin(t*1.05 + ph) * 0.10;
    const roul = Math.sin(t*0.80 + ph + 1.7) * 0.045;
    b.obj.position.set(pos.x, tang, pos.z);
    // orientation : tangent au path (Y world = atan2 du vecteur tangent xz)
    const heading = Math.atan2(_M_Mer_pathPosNext.x, _M_Mer_pathPosNext.z);
    b.obj.rotation.y = heading;
    b.obj.rotation.z = roul;
    b.obj.rotation.x = Math.sin(t*0.6 + ph + 3.1) * 0.025;
    // sillage : ré-injecte un plan à la poupe toutes les 0.4 s
    b.trailTimer += dt;
    if(b.trailTimer > 0.4){
      b.trailTimer = 0;
      const back = b.trail[b.trailIdx];
      back.obj.position.set(
        pos.x - _M_Mer_pathPosNext.x * 2.2,
        0.05,
        pos.z - _M_Mer_pathPosNext.z * 2.2,
      );
      back.obj.rotation.z = heading;   // orienté selon la coque
      back.age = 0;
      b.trailIdx = (b.trailIdx + 1) % b.trail.length;
    }
    for(const tr of b.trail){
      tr.age = Math.min(1, tr.age + dt * 0.42);
      const a = tr.age;
      tr.obj.material.opacity = (1 - a) * 0.55;
      tr.obj.scale.set(1 + a*4.5, 1 + a*1.6, 1);
    }
    // fumée vapeur
    if(b.smoke){
      for(const p of b.smoke){
        p.age += dt * 0.20;             // ~5 s cycle
        if(p.age >= 1) p.age -= 1;
        const a = p.age;
        // anchor world : position bateau + offset cheminée (transformé par rotation y)
        const sp = b.obj.userData.stackPos;
        const cy = Math.cos(heading), sy = Math.sin(heading);
        const wx = pos.x + sp.x*cy + sp.z*sy;
        const wz = pos.z - sp.x*sy + sp.z*cy;
        const wy = sp.y + tang;
        // monte de 0 à +9, dérive est, dilatation
        p.obj.position.set(wx + a*4, wy + a*9, wz);
        const s = 1.8 + a*4;
        p.obj.scale.set(s, s, 1);
        p.obj.material.opacity = Math.sin(a*Math.PI) * 0.40;
      }
    }
  }
}
function buildBourse(g){             // « le phare du capital » — verticale, rayonnante
  const pierre=pierreDeTailleTexture('clair');
  const matStone=new THREE.MeshStandardMaterial({
    color:0xb8ad98, map:pierre.map, roughnessMap:pierre.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  const matStoneDark=new THREE.MeshStandardMaterial({
    color:0x9b906f, map:pierre.map, roughnessMap:pierre.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  const matGold=new THREE.MeshStandardMaterial({
    color:0xb89758, roughness:0.35, metalness:0.85, flatShading:true,
  });
  const matGoldDark=new THREE.MeshStandardMaterial({
    color:0x7a6235, roughness:0.55, metalness:0.7, flatShading:true,
  });
  // Verrière dorée — material avec emissive + tag M4 (couplage profit/capital
  // appliqué dans updateBourseSkin)
  const matVerriere=new THREE.MeshStandardMaterial({
    color:0xb89758, emissive:new THREE.Color(0xffd98a), emissiveIntensity:1.4,
    roughness:0.35, metalness:0.5, flatShading:true,
  });
  matVerriere.userData.m4Role='bourse-verriere';

  // ---------- SOUBASSEMENT débordant (M5b — ancrage au sol) ----------
  const soubB=new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 0.45, 8), matStoneDark);
  soubB.position.y=-0.15; soubB.receiveShadow=true; g.add(soubB);

  // ---------- PARVIS ROND + perron circulaire ----------
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(7.6, 7.6, 0.22, 16), matStoneDark), 0, 0.11, 0);
  for(let i=0;i<3;i++){
    _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(2.8-i*0.35, 2.8-i*0.35, 0.24, 16), matStoneDark),
      0, 0.12+i*0.24, 5.4);
  }

  // ---------- PLINTHE octogonale ----------
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 1.2, 8), matStoneDark), 0, 0.6, 0);

  // ---------- CORPS octogonal (pierre de taille claire) ----------
  const bodyR=5.0, bodyH=9.0;
  const body=new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyH, 8, 1, false), matStone);
  body.position.y=1.2 + bodyH/2; body.castShadow=true; body.receiveShadow=true;
  g.add(body);

  // ---------- FRISE inférieure (denticules subtils) + CORNICHE ----------
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(bodyR+0.18, bodyR+0.18, 0.35, 8), matStoneDark),
    0, 1.2 + 0.18, 0);
  const cornicheR=bodyR + 0.42;
  const corniche=new THREE.Mesh(new THREE.CylinderGeometry(cornicheR, cornicheR, 0.58, 8), matStoneDark);
  corniche.position.y=1.2 + bodyH + 0.29; corniche.castShadow=true;
  g.add(corniche);
  // bandeau de pluie SOUS la corniche (usure discrète)
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2 + Math.PI/8;
    const cx=Math.cos(a)*(bodyR+0.04), cz=Math.sin(a)*(bodyR+0.04);
    const stain=new THREE.Mesh(new THREE.PlaneGeometry(bodyR*0.92, 0.55),
      new THREE.MeshBasicMaterial({color:0x3a2f24, transparent:true, opacity:0.30, depthWrite:false}));
    stain.position.set(cx, 1.2 + bodyH - 0.4, cz); stain.lookAt(0, stain.position.y, 0); stain.rotation.y+=Math.PI;
    g.add(stain);
  }

  // ---------- BANDEAU DE COTATIONS défilant (canvas anim via offset) ----------
  const cotTex=_cotationsTexture();
  const cotMat=new THREE.MeshStandardMaterial({
    color:0x20242a, map:cotTex,
    emissive:new THREE.Color(0x9ad17a), emissiveIntensity:0.40,
    roughness:0.6, metalness:0.1, flatShading:true,
  });
  cotMat.userData.cotations=true;
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2 + Math.PI/8;
    const cx=Math.cos(a)*(bodyR+0.05), cz=Math.sin(a)*(bodyR+0.05);
    const band=new THREE.Mesh(new THREE.PlaneGeometry(bodyR*0.82, 0.62), cotMat);
    band.position.set(cx, 7.6, cz); band.lookAt(0, 7.6, 0); band.rotation.y+=Math.PI;
    g.add(band);
  }

  // ---------- FENÊTRES CINTRÉES (1 par face octogonale) ----------
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2 + Math.PI/8;
    const fx=Math.cos(a)*(bodyR + 0.04), fz=Math.sin(a)*(bodyR + 0.04);
    const w=createArchedWindow(0.95, 2.4);
    w.position.set(fx, 3.4, fz);
    w.lookAt(0, 3.4, 0); w.rotation.y+=Math.PI;
    g.add(w);
  }

  // ---------- COLONNADE FINE (8 colonnes plus minces aux angles) ----------
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2;
    const cx=Math.cos(a)*(bodyR + 0.65);
    const cz=Math.sin(a)*(bodyR + 0.65);
    const c=createColumn(bodyH + 0.6, 0.30);
    c.position.set(cx, 1.2, cz); g.add(c);
  }

  // ---------- OCULUS ÉMISSIFS sur le pourtour de la corniche ----------
  const ocuY=1.2 + bodyH + 0.62;
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2 + Math.PI/8;
    const ox=Math.cos(a)*(cornicheR - 0.08), oz=Math.sin(a)*(cornicheR - 0.08);
    const oc=new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), matVerriere);
    oc.position.set(ox, ocuY, oz);
    oc.rotation.x=-Math.PI/2;
    g.add(oc);
  }

  // ---------- ROTONDE / LANTERNE SOMMITALE — verrière dorée ----------
  const lantR=2.4, lantH=2.6;
  const lantY0=1.2 + bodyH + 0.58;
  // tambour
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(lantR, lantR, 0.30, 16), matStoneDark),
    0, lantY0 + 0.15, 0);
  // colonnettes (8)
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2;
    _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, lantH, 6), matStoneDark),
      Math.cos(a)*lantR, lantY0 + lantH/2 + 0.30, Math.sin(a)*lantR);
  }
  // VERRIÈRE — 8 panneaux émissifs goldLight (tag M4)
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2 + Math.PI/8;
    const cx=Math.cos(a)*(lantR - 0.06), cz=Math.sin(a)*(lantR - 0.06);
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(lantR*0.74, lantH*0.92), matVerriere);
    panel.position.set(cx, lantY0 + lantH/2 + 0.30, cz);
    panel.lookAt(0, panel.position.y, 0); panel.rotation.y+=Math.PI;
    g.add(panel);
  }
  // corniche supérieure de la lanterne
  _addAt(g, new THREE.Mesh(new THREE.CylinderGeometry(lantR+0.22, lantR+0.22, 0.30, 16), matStoneDark),
    0, lantY0 + lantH + 0.45, 0);
  // DÔME doré (demi-sphère)
  const domeY=lantY0 + lantH + 0.60;
  _addAt(g, new THREE.Mesh(new THREE.SphereGeometry(lantR, 16, 10, 0, Math.PI*2, 0, Math.PI/2), matGold),
    0, domeY, 0);

  // ---------- GIROUETTE EN FORME DE PIÈCE (£) ----------
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), matGoldDark);
  mast.position.y=domeY + lantR*0.78 + 0.7; g.add(mast);
  const coin=new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.08, 24), matGold);
  coin.rotation.x=Math.PI/2;
  coin.position.y=domeY + lantR*0.78 + 1.5;
  coin.userData.weatherVane=true;
  _M5_bourseCoin=coin;
  g.add(coin);
  // petit £ gravé sur la pièce
  const coinLab=createSign('£'); coinLab.scale.set(0.6, 0.6, 1);
  coinLab.position.copy(coin.position); coinLab.position.z+=0.06;
  g.add(coinLab);

  // ---------- PORTE D'ENTRÉE BRONZE (face avant) ----------
  const door=createBronzeDoor(2.4, 3.6);
  door.position.set(0, 0, bodyR + 0.05);
  g.add(door);

  // ---------- ENSEIGNE BOURSE sur le tambour ----------
  const sp=createSign('BOURSE'); sp.scale.set(3, 1.3, 1);
  sp.position.set(0, lantY0 + lantH*0.4 + 0.30, lantR + 0.08);
  g.add(sp);
}

/* v61 — LA GRAND-RUE DÉTAILLÉE. Elle existe avant le capital, et se lit comme
   une vraie rue du XIXe : chaussée PAVÉE (texture générée), caniveau central,
   double ORNIÈRE de chariots, TROTTOIRS surélevés à bordures d'encre et joints
   de dalles, PASSAGES pavés vers chaque institution (nord) et chaque parcelle
   (sud), BORNES de pierre régulières, flaques sombres. Quasi que des plans :
   coût de rendu négligeable. */
/* =====================================================================
   M3 — TEXTURES PBR PROCÉDURALES POUR LE SOL.
   3 fabriques (paveTexture, terreTexture, planchesTexture) renvoient
   { map, roughnessMap } : couleur sRGB + grayscale linéaire.
   512px, RepeatWrapping, anisotropy 8. Le canal vert du roughnessMap
   multiplie material.roughness (joints rugueux, plaques d'humidité
   lisses ~0.25, ornières satinées). Voir buildMainStreet / buildPuddles
   / buildGroundPatches plus bas pour l'usage.
   ===================================================================== */
const PBR_AF = 8;
function _texColor(canvas){
  const t=new THREE.CanvasTexture(canvas);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=PBR_AF; return t;
}
function _texLinear(canvas){
  // roughnessMap / dataMaps : on neutralise la conversion sRGB.
  const t=new THREE.CanvasTexture(canvas);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=PBR_AF;
  t.colorSpace=THREE.NoColorSpace; return t;
}
function _seededRnd(seed){ let s=seed|0; return ()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }; }

/* paveTexture(variant) : pavés en appareil décalé autour de 0x4a4540.
   variant 0 = sombre / pauvre, 1 = standard, 2 = clair / institutionnel. */
function paveTexture(variant=1){
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0x4a45 + variant*9173);
  const BASE=[{r:0x42,g:0x3d,b:0x38},{r:0x4a,g:0x45,b:0x40},{r:0x5e,g:0x57,b:0x4d}][variant]||
             {r:0x4a,g:0x45,b:0x40};
  // joints sombres + roughness max (joint pierreux/poreux)
  x.fillStyle=`rgb(${BASE.r-30},${BASE.g-26},${BASE.b-22})`; x.fillRect(0,0,512,512);
  r.fillStyle='#f0f0f0'; r.fillRect(0,0,512,512);
  const tones=[
    `rgb(${BASE.r-14},${BASE.g-11},${BASE.b-9})`,
    `rgb(${BASE.r},${BASE.g},${BASE.b})`,
    `rgb(${BASE.r+22},${BASE.g+18},${BASE.b+13})`,
  ];
  const ROW=36, COL=58;
  for(let row=0, y=-6; y<530; y+=ROW, row++){
    const off=(row%2)?COL/2:0;
    for(let cx=-off; cx<540; cx+=COL){
      const w=COL-6+(rnd()-0.5)*7, h=ROW-5+(rnd()-0.5)*4;
      const px=cx+(rnd()-0.5)*3, py=y+(rnd()-0.5)*3;
      const tone=tones[(rnd()*3)|0];
      x.fillStyle=tone;
      x.beginPath();
      if(x.roundRect) x.roundRect(px,py,w,h,3); else x.rect(px,py,w,h);
      x.fill();
      // surface du pavé : roughness ~0.88 (très légèrement variable)
      const rg=215+Math.floor(rnd()*22);
      r.fillStyle=`rgb(${rg},${rg},${rg})`;
      r.beginPath();
      if(r.roundRect) r.roundRect(px+1,py+1,w-2,h-2,3); else r.rect(px+1,py+1,w-2,h-2);
      r.fill();
      // grain
      if(rnd()<0.55){
        x.fillStyle=`rgba(0,0,0,${0.04+rnd()*0.08})`;
        for(let k=0;k<6;k++) x.fillRect(px+rnd()*w, py+rnd()*h, 1+rnd()*2, 1+rnd()*2);
      }
      // pierres fendues (5-10%)
      if(rnd()<0.08){
        x.strokeStyle='rgba(14,10,8,0.6)'; x.lineWidth=1.1;
        x.beginPath();
        const x0=px+rnd()*w*0.3, y0=py+rnd()*h, x1=px+w-rnd()*w*0.3, y1=py+rnd()*h;
        x.moveTo(x0,y0); x.lineTo(x1,y1); x.stroke();
      }
    }
  }
  // plaques d'humidité sombres (~30% surface) — roughness basse (~0.25)
  const PUDDLE_N=14;
  for(let i=0;i<PUDDLE_N;i++){
    const px=rnd()*512, py=rnd()*512, rr=22+rnd()*70;
    const g=x.createRadialGradient(px,py,rr*0.2,px,py,rr);
    g.addColorStop(0,`rgba(14,18,24,${0.18+rnd()*0.22})`); g.addColorStop(1,'rgba(14,18,24,0)');
    x.fillStyle=g; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
    const gr=r.createRadialGradient(px,py,rr*0.15,px,py,rr);
    gr.addColorStop(0,'rgba(64,64,64,0.95)'); gr.addColorStop(1,'rgba(64,64,64,0)');
    r.fillStyle=gr; r.beginPath(); r.arc(px,py,rr,0,Math.PI*2); r.fill();
  }
  return { map:_texColor(c), roughnessMap:_texLinear(rc) };
}

/* terreTexture() : terre tassée dorée 0x9a7a4a, cailloux, ornières, herbe morte. */
function terreTexture(){
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0x9a7a4a);
  // base : terre dorée, dégradé subtil
  const g=x.createRadialGradient(256,256,40,256,256,360);
  g.addColorStop(0,'#ab8554'); g.addColorStop(0.55,'#9a7a4a'); g.addColorStop(1,'#866840');
  x.fillStyle=g; x.fillRect(0,0,512,512);
  r.fillStyle='#ececec'; r.fillRect(0,0,512,512);          // terre mate ~0.92
  // plaques desséchées (claires) et zones plus humides (sombres)
  for(let i=0;i<34;i++){
    const px=rnd()*512, py=rnd()*512, rr=28+rnd()*90;
    const palette=['200,170,114','170,138,84','118,98,68','220,190,128'];
    const tone=palette[(rnd()*4)|0];
    const gr=x.createRadialGradient(px,py,rr*0.2,px,py,rr);
    gr.addColorStop(0,`rgba(${tone},${0.10+rnd()*0.20})`); gr.addColorStop(1,`rgba(${tone},0)`);
    x.fillStyle=gr; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
  }
  // cailloux
  for(let i=0;i<280;i++){
    const px=rnd()*512, py=rnd()*512, k=30+rnd()*60;
    x.fillStyle=`rgba(${k+30},${k+22},${k+10},${0.40+rnd()*0.40})`;
    x.fillRect(px,py,1+rnd()*2.4,1+rnd()*2.0);
  }
  // ornières de roues parallèles — 2 couples (deux passages)
  for(const yy of [188,206,310,328]){
    const gr=x.createLinearGradient(0,yy-7,0,yy+7);
    gr.addColorStop(0,'rgba(44,34,20,0)');
    gr.addColorStop(0.5,'rgba(44,34,20,0.42)');
    gr.addColorStop(1,'rgba(44,34,20,0)');
    x.fillStyle=gr; x.fillRect(0,yy-7,512,14);
    // ornière satinée (un peu d'humidité résiduelle, roughness ~0.55)
    const rgr=r.createLinearGradient(0,yy-7,0,yy+7);
    rgr.addColorStop(0,'rgba(140,140,140,0)');
    rgr.addColorStop(0.5,'rgba(140,140,140,0.55)');
    rgr.addColorStop(1,'rgba(140,140,140,0)');
    r.fillStyle=rgr; r.fillRect(0,yy-7,512,14);
  }
  // herbe morte éparse en lisière (densité plus forte près des bords)
  for(let i=0;i<100;i++){
    const px=rnd()*512, py=rnd()*512;
    const edge=Math.min(px,512-px,py,512-py);
    if(edge>96 && rnd()<0.75) continue;
    x.strokeStyle=`rgba(150,128,84,${0.32+rnd()*0.35})`; x.lineWidth=1;
    x.beginPath(); x.moveTo(px,py); x.lineTo(px+(rnd()-0.5)*4, py-2-rnd()*3); x.stroke();
  }
  // grain global
  for(let i=0;i<900;i++){
    const px=rnd()*512, py=rnd()*512;
    x.fillStyle=rnd()<0.5?`rgba(58,44,26,${0.07+rnd()*0.10})`:`rgba(204,178,128,${0.06+rnd()*0.10})`;
    x.fillRect(px,py,1+rnd()*1.5,1+rnd()*1.5);
  }
  return { map:_texColor(c), roughnessMap:_texLinear(rc) };
}

/* planchesTexture() : planches de quai, veines, clous, espacement irrégulier.
   Réutilisée par le port en M6 (le quai courant n'est pas encore branché ici). */
function planchesTexture(){
  const c=document.createElement('canvas'); c.width=c.height=512; const x=c.getContext('2d');
  const rc=document.createElement('canvas'); rc.width=rc.height=512; const r=rc.getContext('2d');
  const rnd=_seededRnd(0xb19478);
  x.fillStyle='#7a6648'; x.fillRect(0,0,512,512);
  r.fillStyle='#dcdcdc'; r.fillRect(0,0,512,512);             // bois ~0.86
  let y=0;
  while(y<512){
    const h=36+(rnd()*22);
    const tone=90+(rnd()*32);
    x.fillStyle=`rgb(${tone+30},${tone+12},${(tone-12)|0})`;
    x.fillRect(0,y,512,h);
    // veines bois (cubic-bezier ondoyantes)
    for(let v=0; v<5; v++){
      x.strokeStyle=`rgba(60,42,22,${0.10+rnd()*0.18})`; x.lineWidth=0.7+rnd()*0.8;
      x.beginPath();
      const vy=y+4+rnd()*(h-8);
      x.moveTo(0,vy);
      for(let k=0;k<6;k++){
        x.bezierCurveTo(k*100+30, vy+(rnd()-0.5)*4, k*100+60, vy+(rnd()-0.5)*4, (k+1)*100, vy+(rnd()-0.5)*4);
      }
      x.stroke();
    }
    // joint sombre (espacement irrégulier)
    x.fillStyle='#241f17'; x.fillRect(0,y+h-2,512,2);
    r.fillStyle='#f8f8f8'; r.fillRect(0,y+h-2,512,2);
    // clous (têtes de fer)
    for(const cx of [16,496]){
      x.fillStyle='#2a2620'; x.beginPath(); x.arc(cx,y+h/2,2.2,0,Math.PI*2); x.fill();
      x.fillStyle='#5a4a35'; x.beginPath(); x.arc(cx-0.5,y+h/2-0.5,1.1,0,Math.PI*2); x.fill();
    }
    y+=h;
  }
  return { map:_texColor(c), roughnessMap:_texLinear(rc) };
}
/* v56 — le littoral est : bande d'eau, lignes de houle à l'encre, bateaux à quai.
   C'est de la géographie (toujours visible), pas du décor d'époque. */
let _boats=[];
/* =====================================================================
   M6 — MER ANIMÉE (ShaderMaterial).
   Vertex : 3 sinusoïdes additives sur Y, normales recalculées par dérivée
   analytique → pas de glitch d'éclairage.
   Fragment : base 0x35586b + traînée dorée gradiente vers l'ouest (sun set)
   + reflets ponctuels des fanaux (cercles atténués), + écume crête.
   Coût : ~ 4000 verts (5×80 segs), 2 ms en frame test puppeteer.
   ===================================================================== */
let _M6_waterMaterial = null;
function buildWaterEast(){
  // ----- ShaderMaterial -----
  // M7-soleil : uAstreDir (xz du soleil/lune dominant), uAstreColor, uAstreUp
  // (élévation 0..1) ; la traînée pointe toujours vers l'astre visible.
  // M-Peaufinage/B : 4 fanaux supplémentaires le long du quai (lumières
  //   nocturnes du port). Tous reflétés par l'eau.
  const uniforms={
    uTime:      { value: 0 },
    uColor:     { value: new THREE.Color(0x35586b) },
    uGold:      { value: new THREE.Color(COLORSCRIPT.skyHorizon) },
    uFanal0:    { value: new THREE.Vector3(114,   1.2, -8) },
    uFanal1:    { value: new THREE.Vector3(114.5, 1.2, 14) },
    uFanal2:    { value: new THREE.Vector3(112.5, 1.0, -28) },
    uFanal3:    { value: new THREE.Vector3(113,   1.0,  32) },
    uFanal4:    { value: new THREE.Vector3(112,   1.0, -56) },
    uFanal5:    { value: new THREE.Vector3(113.5, 1.0,  60) },
    uAstreDir:  { value: new THREE.Vector2(-1, 0) },     // xz monde, normalisé
    uAstreColor:{ value: new THREE.Color(COLORSCRIPT.skyHorizon) },
    uAstreUp:   { value: 0.20 },                           // élévation [0..1]
    uIsMoon:    { value: 0.0 },                            // 0=jour, 1=nuit
    uFogColor:  { value: new THREE.Color(0x5a5560) },      // synchronisé avec scene.fog
    uFogNear:   { value: 90.0 },
    uFogFar:    { value: 260.0 },
  };
  _M6_waterMaterial=new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader:`
      uniform float uTime;
      varying vec3  vWorldPos;
      varying vec3  vNrm;
      varying float vSeaMix;     // 0 près du quai → 1 au grand large
      void main(){
        // M-Mer/A + correctif-clapot : HOULE par superposition de 4 sinus
        //   modulés par seaMix (calmes près du quai, fortes au large) +
        //   un 5e sinus CLAPOT haute fréquence à AMPLITUDE CONSTANTE,
        //   appliqué partout sans atténuation → garantit qu'AUCUNE zone
        //   d'eau n'est figée, même contre la berge ou le quai.
        //   Plancher de gain remonté à 0.50 (au lieu de 0.30) pour que
        //   la houle reste lisible jusqu'au rivage.
        vec3 p = position;
        // worldX provisoire (pour gradient calme→large). La plane est en XY
        //   local ; le modelMatrix la pose au sol et la translate à x=305.
        float worldX = (modelMatrix * vec4(p, 1.0)).x;
        float seaMix = smoothstep(115.0, 165.0, worldX);   // 0..1 sur ~50 m
        // 4 sinus de houle : 2 longs, 1 oblique, 1 court.
        float w1 = sin(p.x*0.40 + uTime*0.65) * 0.20;
        float w2 = sin(p.y*0.18 + uTime*0.43) * 0.26;
        float w3 = sin((p.x + p.y)*0.12 + uTime*0.90) * 0.14;
        float w4 = sin(p.x*1.10 - p.y*0.70 + uTime*1.30) * 0.06;
        // amplitude gradient : floor 0.50 au rivage, 1.10 au large
        float gain = mix(0.50, 1.10, seaMix);
        // 5e sinus — CLAPOT HF : amplitude constante 5 cm, NON atténué.
        //   Période ~11m (freq 0.55) bien échantillonnée par la grille
        //   80×140, phase rapide → surface ondule visiblement partout,
        //   y compris quai et rivage.
        float w5 = sin(p.x*0.55 + p.y*0.25 + uTime*1.85) * 0.05;
        p.z += (w1 + w2 + w3 + w4) * gain + w5;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        vSeaMix = seaMix;
        // normales analytiques (dérivées des sinus). Les 4 premières
        //   héritent du gain ; w5 contribue à amplitude PLEINE → reflets
        //   ondulent partout, même au rivage.
        float dx = (cos(p.x*0.40 + uTime*0.65)*0.40*0.20
                 +  cos((p.x+p.y)*0.12 + uTime*0.90)*0.12*0.14
                 +  cos(p.x*1.10 - p.y*0.70 + uTime*1.30)*1.10*0.06) * gain
                 + cos(p.x*0.55 + p.y*0.25 + uTime*1.85)*0.55*0.05;
        float dz = (cos(p.y*0.18 + uTime*0.43)*0.18*0.26
                 +  cos((p.x+p.y)*0.12 + uTime*0.90)*0.12*0.14) * gain
                 + cos(p.x*0.55 + p.y*0.25 + uTime*1.85)*0.25*0.05;
        vNrm = normalize(vec3(-dx, 1.0, -dz));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader:`
      uniform float uTime;
      uniform vec3  uColor;
      uniform vec3  uGold;
      uniform vec3  uFanal0;
      uniform vec3  uFanal1;
      uniform vec3  uFanal2;
      uniform vec3  uFanal3;
      uniform vec3  uFanal4;
      uniform vec3  uFanal5;
      uniform vec3  uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec2  uAstreDir;
      uniform vec3  uAstreColor;
      uniform float uAstreUp;
      uniform float uIsMoon;
      varying vec3  vWorldPos;
      varying vec3  vNrm;
      varying float vSeaMix;
      // M-Peaufinage/B : helper réflexe-fanal (compacte le code, mêmes
      //   coefficients que l'original 0.55 / 0.85 / 0.15).
      float reflexFanal(vec2 wp, vec3 f, float phase){
        float d = length(wp - f.xz);
        return exp(-d*0.50) * (0.85 + 0.15*sin(uTime*phase + d*0.6));
      }
      void main(){
        vec3 col = uColor;
        // M-Peaufinage/B : TRAÎNÉE SPÉCULAIRE désormais visible EN TOUT
        //   TEMPS (le gate horizonK ne descend plus jamais sous 0.30).
        //   L'eau n'est plus jamais un aplat — l'astre y imprime toujours.
        vec2 wp2 = vWorldPos.xz - vec2(110.0, 0.0);
        vec2 dir = normalize(uAstreDir);
        vec2 perpD = vec2(-dir.y, dir.x);
        float along  = dot(wp2, dir);
        float across = dot(wp2, perpD);
        float bandW = 4.0 + abs(along)*0.18;
        float streak = exp(-pow(across/bandW, 2.0)) * smoothstep(-3.0, 4.0, along);
        float wave = sin(across*0.20 + uTime*0.45)*0.05 + sin(along*0.07 + uTime*0.30)*0.08;
        streak *= (0.85 + wave*0.6);
        float horizonK = exp(-pow((uAstreUp - 0.12)*4.0, 2.0));
        float strength = 0.75 + 0.35*uIsMoon;   // ↑ jour 0.75, nuit 1.10
        vec3 streakCol = mix(uAstreColor, vec3(0.92, 0.94, 1.00), uIsMoon * 0.55);
        // ↑ floor : la traînée est visible MÊME quand l'astre est haut.
        col += streakCol * streak * strength * (0.55 + 0.45*horizonK);
        // teinte globale plus chaude côté astre (jour) — froide la nuit
        float warmth = clamp(dot(normalize(wp2 + vec2(0.001,0.0)), dir), 0.0, 1.0);
        col = mix(col, streakCol, warmth * (0.40 - uIsMoon*0.10));

        // M-Peaufinage/B : BANDE DE REFLET DE SKYLINE/QUAI.
        //   Une zone près de la berge (along < 8) reçoit un reflet diffus
        //   ondulant des lumières chaudes du quai et de la skyline ouest.
        //   Active à toute heure (modulée par le facteur nuit pour les
        //   lampes émissives), réfléchit en bandes horizontales.
        float quaiBand = exp(-along*along*0.012) * smoothstep(-2.0, 0.5, along);
        float quaiWave = 0.55 + 0.45 * sin(across*0.30 + uTime*0.8);
        vec3  quaiCol  = vec3(1.00, 0.72, 0.38);
        col += quaiCol * quaiBand * quaiWave * (0.18 + 0.45*uIsMoon);

        // FANAUX — 6 lumières le long du quai (au lieu de 2 seulement).
        //   Reflets ondulants ponctuels qui montent en intensité la nuit.
        float r0 = reflexFanal(vWorldPos.xz, uFanal0, 2.2);
        float r1 = reflexFanal(vWorldPos.xz, uFanal1, 2.5);
        float r2 = reflexFanal(vWorldPos.xz, uFanal2, 2.0);
        float r3 = reflexFanal(vWorldPos.xz, uFanal3, 2.7);
        float r4 = reflexFanal(vWorldPos.xz, uFanal4, 2.3);
        float r5 = reflexFanal(vWorldPos.xz, uFanal5, 2.6);
        float rSum = r0 + r1 + r2 + r3 + r4 + r5;
        col += vec3(1.0, 0.78, 0.42) * rSum * 0.50 * (0.30 + uIsMoon*0.70);

        // M-Mer/A : ÉCUME sur les crêtes — gradient amplitude par seaMix.
        //   Près du quai : crêtes lisses, faible foam. Au large : crêtes
        //   marquées, foam visible (chaque crête se relève, le blanc apparaît
        //   quand la normale s'incline). Reste sous le seuil bloom (0.82).
        float foam = smoothstep(0.25, 0.85, (1.0 - vNrm.y) * 5.0);
        float foamAmp = mix(0.18, 0.62, vSeaMix);   // près quai 0.18 / au large 0.62
        col += vec3(0.55) * foam * foamAmp;
        // micro-scintillement de crête (sous le bloom) : 2 nappes de bruit
        //   modulées par la pente. Discret, donne le frémissement de l'eau
        //   sous une brise — toujours sous 0.5 de luminance.
        float sparkle = sin(vWorldPos.x*1.6 + uTime*1.7) * sin(vWorldPos.z*1.9 - uTime*1.2);
        sparkle = max(0.0, sparkle - 0.75) * foam * vSeaMix;
        col += vec3(0.65, 0.72, 0.78) * sparkle * 0.45;
        // M-Mer/A : FONDU FOG manuel — le plan ignore le fog scene (transparent),
        //   on simule la brume pour fondre l'horizon mer-ciel.
        float dCam = length(cameraPosition - vWorldPos);
        float fogF = smoothstep(uFogNear, uFogFar, dCam);
        col = mix(col, uFogColor, fogF * 0.95);
        float alpha = mix(0.92, 0.55, fogF);   // s'efface au loin pour rejoindre le ciel
        // M-Mer/correctif-rivage : transparence accrue près du rivage pour
        //   que l'eau ne masque pas l'estran mouillé — pas d'arête nette,
        //   l'eau « entre » dans le sable. 0.5 au rivage, 1.0 dès 15m du bord.
        float shoreNear = 1.0 - smoothstep(115.0, 130.0, vWorldPos.x);
        alpha *= mix(1.0, 0.55, shoreNear);
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  // M-Mer/A + correctif-clapot : plan d'eau ÉTENDU jusqu'à la brume.
  //   x ∈ [110, 500], z ∈ [-260, 260]. À grande distance, la couleur
  //   de l'eau est mangée par le fog et se fond dans le ciel/brume.
  //   Segments 80 × 140 (≈11 300 verts) — densifiés pour bien échantillonner
  //   le clapot HF (période ~11m → spacing 4.9m). Coût vertex shader trivial.
  const waterGeo=new THREE.PlaneGeometry(390, 520, 80, 140);
  const water=new THREE.Mesh(waterGeo, _M6_waterMaterial);
  water.rotation.x=-Math.PI/2;
  water.position.set(305, 0.012, 0);   // centré entre 110 et 500
  water.receiveShadow=false;
  scene.add(water);
  // M-Polish/C : berge SUPPRIMÉE — c'était un liseré rectiligne sombre
  //   (PlaneGeometry 0.7×240) qui dessinait une arête trop nette le long
  //   de la côte, visible au premier plan. La transition terre/eau passe
  //   désormais par l'estran bruité (_M6_buildEstran) : bords ondulants,
  //   bosses de sable. La limite playable reste assurée par la barrière
  //   invisible des obstacles à x=111.5 (cf. ligne suivante).
  // M-Mer/correctif-rivage : un bateau ACCOSTÉ contre le quai (face
  //   est, contre la planche x=111) et un MOUILLÉ en eau profonde
  //   (bien au-delà du bord de l'estran à x≈115-117). Tangage et
  //   roulis assurés par WorldBeauty (cf. boucle de rendu).
  for(const [bx, bz, r] of [[112.7, -3, 0.05], [123, 16, -0.45]]){
    const b=createBoat(); b.position.set(bx, 0, bz); b.rotation.y=r;
    scene.add(b); _boats.push(b);
  }
  // barrière invisible le long de la berge — repoussée à la NOUVELLE
  //   limite terre de l'estran (x≈105 max d'oscillation). Empêche le
  //   chariot de descendre sur le sable.
  for(let z=-116; z<=116; z+=11) obstacles.push({pos:new THREE.Vector2(105.5, z), radius:6});
}
function _M6_updateWater(){
  if(!_M6_waterMaterial) return;
  const u = _M6_waterMaterial.uniforms;
  u.uTime.value = t;
  // M7-soleil : traînée pointe vers l'astre dominant.
  u.uAstreDir.value.copy(SunState.dominantDir2D);
  u.uAstreColor.value.copy(SunState.dominantColor);
  // élévation 0..1 (clamp positif — seul l'astre VISIBLE pilote)
  const upY = SunState.dominantIsMoon ? SunState.moonDir.y : SunState.sunDir.y;
  u.uAstreUp.value = Math.max(0, upY);
  u.uIsMoon.value = SunState.dominantIsMoon ? 1.0 : 0.0;
  // M-Mer/A : suit la teinte du fog scene (DayCycle l'anime). Garde l'eau
  //   fondue dans le ciel à l'horizon, même au crépuscule.
  if(scene.fog){
    u.uFogColor.value.copy(scene.fog.color);
    u.uFogNear.value = scene.fog.near;
    u.uFogFar.value  = scene.fog.far;
  }
}

/* =====================================================================
   M6-BORD — FERMETURE DE L'HORIZON.
   La carte jouable s'arrêtait net (bord à ±120, falaise visible dans le
   vide). On la referme par GÉOGRAPHIE NATURELLE :
   - 3 strip-meshes de COLLINES (nord, sud, ouest) — terrain ondulé qui
     monte depuis le bord jouable jusqu'à ~18 m à R≈170, irrégulier par
     bruit sinusoïdal, couleurs par vertex (vert proche → bleu-brume
     loin pour la perspective atmosphérique), fog:true.
   - ARBRES LOINTAINS instanciés (2 InstancedMesh : troncs + feuillage)
     éparpillés sur les flancs.
   - ESTRAN sablonneux étroit entre la berge et l'eau (transition côte
     naturelle, roughness basse pour accrocher la lumière dorée).
   - VOILIERS / PHARE distants en sprites brumeux côté mer.
   Le côté EST est laissé à la mer étendue (buildWaterEast).
   Budget : ~6 draw calls (3 collines + 2 trees instanced + 1 estran +
   N sprites distants).
   ===================================================================== */
let _M6_hillMeshes=[], _M6_distantTreeGroups=[], _M6_distantSails=[];
function _M6_noise2D(x, z, seed=0){
  return (Math.sin(x*0.043 + z*0.029 + seed)
        + Math.sin(x*0.071 - z*0.053 + seed*1.7)*0.7
        + Math.sin(x*0.13 + z*0.11 + seed*0.3)*0.4) / 2.1;
}
function _M6_hillHeight(x, z){
  // distance depuis le bord jouable (max(|x|,|z|) - 118). 0 si dans la zone.
  // Pas de collines côté est (x > 105) — c'est la mer.
  if(x > 105) return 0;
  const edge = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - 118);
  if(edge <= 0) return 0;
  // ramp doux jusqu'à 70 m, puis plateau qui redescend très lentement
  const ramp = Math.min(1, edge/60);
  const PEAK = 18;
  const noise = (_M6_noise2D(x, z, 0)*0.55 + _M6_noise2D(x*2.1, z*1.7, 11)*0.30 + _M6_noise2D(x*4.3, z*3.1, 23)*0.15) * 0.5 + 0.5;
  return PEAK * ramp * (0.55 + noise*0.70);
}
function _M6_hillStrip(xMin, xMax, zMin, zMax, segX, segZ){
  const verts=[], idx=[], cols=[];
  const c=new THREE.Color();
  const cNear=new THREE.Color(0x6b7a4a);   // vert éteint (proche)
  const cFar=new THREE.Color(0x4a5568);    // bleu-brume (loin)
  for(let iz=0; iz<=segZ; iz++){
    for(let ix=0; ix<=segX; ix++){
      const x=xMin + (ix/segX)*(xMax-xMin);
      const z=zMin + (iz/segZ)*(zMax-zMin);
      const y=_M6_hillHeight(x, z);
      verts.push(x, y, z);
      // perspective atmosphérique : couleur lerp selon distance origine
      const r=Math.hypot(x, z);
      const t=Math.min(1, Math.max(0, (r - 130) / 90));
      c.copy(cNear).lerp(cFar, t);
      cols.push(c.r, c.g, c.b);
    }
  }
  for(let iz=0; iz<segZ; iz++){
    for(let ix=0; ix<segX; ix++){
      const a=iz*(segX+1)+ix;
      const b=iz*(segX+1)+ix+1;
      const cc=(iz+1)*(segX+1)+ix;
      const d=(iz+1)*(segX+1)+ix+1;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({
    vertexColors:true, roughness:1.0, metalness:0, flatShading:false, fog:true,
  });
  const m=new THREE.Mesh(geo, mat);
  m.receiveShadow=true; m.castShadow=false;
  return m;
}
function _M6_buildHillsBelt(){
  // 3 strips : NORD (z<-118), SUD (z>118), OUEST (x<-118). Pas de strip est (mer).
  // NORD couvre toute la largeur ; les coins NE/SE sont couverts par l'eau étendue.
  const north=_M6_hillStrip(-260, 260, -260, -118, 26, 16);
  const south=_M6_hillStrip(-260, 260,  118,  260, 26, 16);
  const west =_M6_hillStrip(-260, -118, -118, 118, 16, 14);
  scene.add(north); scene.add(south); scene.add(west);
  _M6_hillMeshes.push(north, south, west);
}
function _M6_buildDistantTrees(){
  // M7 — arbres lointains alignés sur les 4 gabarits M7 (mêmes silhouettes
  // que les arbres proches, mais teintes assombries + fog:true pour la
  // perspective atmosphérique). Mix : chêne (large), pin (sombre conifère).
  let seed=313;
  const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
  const slots=[];
  const tries=900;
  for(let i=0;i<tries && slots.length<80;i++){
    let x, z;
    const side=Math.floor(rnd()*3);
    if(side===0){       x=(rnd()*2-1)*240; z=-130 - rnd()*100; }
    else if(side===1){  x=(rnd()*2-1)*240; z= 130 + rnd()*100; }
    else {              x=-130 - rnd()*100; z=(rnd()*2-1)*100; }
    if(x>105) continue;
    const y=_M6_hillHeight(x, z);
    if(y < 3) continue;
    const kind = (rnd() < 0.55) ? 'pin' : 'chene';      // collines = conifères + chênes
    slots.push({x, y, z, kind, s:0.85 + rnd()*0.7, r:rnd()*Math.PI*2});
  }
  if(!slots.length) return;
  const byKind={chene:[], pin:[]};
  for(const s of slots) byKind[s.kind].push(s);

  const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion(), S=new THREE.Vector3();
  for(const kind of ['chene','pin']){
    const list=byKind[kind]; if(!list.length) continue;
    const tg=_M7_trunkGeo(kind);
    const fg=_M7_foliageGeo(kind);
    // teintes ASSOMBRIES (perspective atmosphérique)
    const matTronc=new THREE.MeshStandardMaterial({color:0x2a221a, roughness:0.95, metalness:0, flatShading:true, fog:true});
    const matFol=new THREE.MeshStandardMaterial({
      color:(kind==='pin' ? 0x2a3a26 : 0x4a5a38),
      roughness:1.0, metalness:0, flatShading:true, fog:true,
    });
    const trunks=new THREE.InstancedMesh(tg, matTronc, list.length);
    const folies=new THREE.InstancedMesh(fg, matFol, list.length);
    trunks.castShadow=false; folies.castShadow=false;
    const foY=_M7_TREE_PARAMS[kind].foliageY;
    list.forEach((sl, i)=>{
      Q.setFromAxisAngle(new THREE.Vector3(0,1,0), sl.r);
      P.set(sl.x, sl.y, sl.z); S.set(sl.s, sl.s, sl.s);
      M.compose(P, Q, S); trunks.setMatrixAt(i, M);
      P.set(sl.x, sl.y + (foY + 0.4)*sl.s, sl.z); S.set(sl.s, sl.s, sl.s);
      M.compose(P, Q, S); folies.setMatrixAt(i, M);
    });
    trunks.instanceMatrix.needsUpdate=true;
    folies.instanceMatrix.needsUpdate=true;
    scene.add(trunks); scene.add(folies);
    _M6_distantTreeGroups.push(trunks, folies);
  }
}
// Fonction de bruit partagée par l'estran et l'écume du rivage : garantit que
//   les sprites d'écume s'alignent EXACTEMENT sur la ligne de marée du
//   mesh estran. Multi-octave (3 sinusoïdes).
function _M_Mer_shoreNoise(z, p){
  return Math.sin(z*0.045 + p)*0.70
       + Math.sin(z*0.105 + p*1.7)*0.40
       + Math.sin(z*0.205 + p*0.6)*0.15;
}
function _M6_buildEstran(){
  // M-Mer/correctif-rivage : ESTRAN ÉLARGI et CONTRASTÉ.
  // - bord TERRE serpente entre x ≈ 105.2 et x ≈ 108.8 (criques/avancées)
  // - bord EAU  serpente entre x ≈ 113.7 et x ≈ 117.3
  // - pente DOUCE : y de +0.07 (sable sec) à -0.32 (sous-marin) sur ~7-12m
  //   La ligne de marée (y ≈ 0.012, surface de l'eau) tombe vers tt ≈ 0.16
  //   selon noise → courbe sinueuse, jamais une ligne droite.
  // - bumps de sable/galets plus marqués au centre.
  // - VERTEX COLORS : sable sec côté terre, vase humide côté eau (lerp).
  const d=270;
  const segX=14, segZ=140;
  const verts=[], idx=[], uvs=[], colors=[];
  const cDry  = new THREE.Color(0x8a7458);   // sable sec doré
  const cWet  = new THREE.Color(0x2a221a);   // vase mouillée très sombre
  const tmpC  = new THREE.Color();
  for(let iz=0; iz<=segZ; iz++){
    const z = -d/2 + (iz/segZ)*d;
    const xLand  = 107.0 + _M_Mer_shoreNoise(z, 0.0) * 1.6;   // ±~1.8
    const xWater = 115.5 + _M_Mer_shoreNoise(z, 1.7) * 1.5;   // ±~1.7
    for(let ix=0; ix<=segX; ix++){
      const tt = ix/segX;
      const x = xLand + tt*(xWater - xLand);
      // pente douce : 0.07 (terre) → -0.32 (eau profonde). Croise la
      //   surface d'eau (y=0.012) vers tt ≈ 0.15 — la marée n'est plus
      //   une ligne droite mais une courbe sinueuse.
      let y = 0.070 - tt*0.390;
      // bumps de sable (bruit HF amorti aux bords)
      const edgeAmp = Math.sin(tt*Math.PI);
      y += edgeAmp * (Math.sin(z*0.31 + ix*0.7)*0.038
                    + Math.sin(z*0.83 - ix*0.4)*0.022
                    + Math.sin(z*1.45 + ix*0.2)*0.011);
      verts.push(x, y, z);
      uvs.push(tt*2.0, iz/segZ*24);
      // couleur : sec → humide selon tt (les zones immergées sont sombres
      //   et mouillées). Plus contraste fort que la version précédente.
      const wetK = Math.min(1, Math.max(0, (tt-0.05)*1.55));
      tmpC.copy(cDry).lerp(cWet, wetK);
      colors.push(tmpC.r, tmpC.g, tmpC.b);
    }
  }
  for(let iz=0; iz<segZ; iz++){
    for(let ix=0; ix<segX; ix++){
      const a=iz*(segX+1)+ix, b=iz*(segX+1)+ix+1;
      const cc=(iz+1)*(segX+1)+ix, dd=(iz+1)*(segX+1)+ix+1;
      idx.push(a, cc, b, b, cc, dd);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const t=terreTexture();
  const mat=new THREE.MeshStandardMaterial({
    map:t.map, roughnessMap:t.roughnessMap,
    vertexColors:true,
    roughness:0.55, metalness:0.05,
  });
  const m=new THREE.Mesh(geo, mat);
  m.receiveShadow=true; scene.add(m);
}
function _M6_buildDistantSails(){
  // 2 sprites brumeux côté mer : voiliers distants (phare supprimé en M13b
  //   pour laisser l'horizon-eau vide de toute silhouette de bâtiment).
  const mkSailTex=()=>{
    const c=document.createElement('canvas'); c.width=128; c.height=96;
    const x=c.getContext('2d');
    x.clearRect(0,0,128,96);
    // coque (forme aplatie)
    x.fillStyle='rgba(40,32,22,0.85)';
    x.beginPath();
    x.moveTo(20, 70); x.lineTo(108, 70); x.lineTo(96, 80); x.lineTo(32, 80);
    x.closePath(); x.fill();
    // voile 1 (grande triangle)
    x.fillStyle='rgba(232,220,196,0.85)';
    x.beginPath();
    x.moveTo(64, 12); x.lineTo(96, 70); x.lineTo(64, 70); x.closePath(); x.fill();
    // voile 2 (petit triangle à l'avant)
    x.beginPath();
    x.moveTo(64, 24); x.lineTo(40, 70); x.lineTo(64, 70); x.closePath(); x.fill();
    // mât
    x.fillStyle='rgba(40,32,22,0.85)';
    x.fillRect(63, 10, 2, 60);
    return new THREE.CanvasTexture(c);
  };
  const sailTex=mkSailTex();
  // 2 voiliers, distance 220 et 250, hauteur ~6m. M13b — le phare lointain
  //   (silhouette de bâtiment maritime statique) est SUPPRIMÉ : aucune
  //   silhouette côté eau. Les voiliers restent — ce sont des navires,
  //   éléments maritimes légitimes (le shader d'eau s'occupe seul des
  //   reflets ; rien à enlever côté reflet puisqu'aucun reflet de phare
  //   n'était imprimé dans le shader).
  const sail1=new THREE.Sprite(new THREE.SpriteMaterial({
    map:sailTex, color:0xffffff, transparent:true, opacity:0.75,
    depthWrite:false, fog:true,
  }));
  sail1.scale.set(14, 10, 1);
  sail1.position.set(195, 6, -45);
  scene.add(sail1);
  const sail2=new THREE.Sprite(new THREE.SpriteMaterial({
    map:sailTex, color:0xffffff, transparent:true, opacity:0.65,
    depthWrite:false, fog:true,
  }));
  sail2.scale.set(11, 8, 1);
  sail2.position.set(210, 5, 60);
  scene.add(sail2);
  _M6_distantSails.push(sail1, sail2);
}
function buildClosingHorizon(){
  _M6_buildHillsBelt();
  _M6_buildDistantTrees();
  _M6_buildEstran();
  _M6_buildDistantSails();
}
function _applyM6BordQuality(q){
  // Basse : moins d'arbres lointains, sprites distants masqués.
  const low = (q === 'low');
  for(const tr of _M6_distantTreeGroups){
    if(!tr.userData.maxCount) tr.userData.maxCount = tr.count;
    tr.count = low ? Math.floor(tr.userData.maxCount * 0.35) : tr.userData.maxCount;
  }
  for(const s of _M6_distantSails) s.visible = !low;
}
if(typeof window!=='undefined') window._applyM6BordQuality = _applyM6BordQuality;
/* =====================================================================
   M3 — GRAND-RUE PBR.
   Chaussée pavée (paveTexture variant 1) + caniveau central creusé
   (paveTexture variant 0, roughness basse) + trottoirs surélevés h=0.18
   en pierre plus claire (variant 2). Bordures et bornes en InstancedMesh.
   Sol mat partout (material.roughness=1, modulé par roughnessMap) SAUF
   le caniveau (humide) et les flaques (cf. buildPuddles).
   Total : 5 draw calls (1 chaussée + 1 caniveau + 2 trottoirs + 1 bornes).
   ===================================================================== */
const M3_Y = {
  patches:    0.004,  // zone class patches (sous tout)
  road:       0.015,  // chaussée
  caniveau:   0.018,  // bande centrale humide
  puddles:    0.025,  // flaques réfléchissantes
  paperDebris:0.020,
  shardDebris:0.025,
  stoneDebris:0.050,
};
const M3_MAT = {};
const M3_MESHES = [];
let   M3_PUDDLE_MESH = null;
let   M3_DEBRIS = [];
function buildMainStreet(){
  const x0=-112, x1=104, w=15, cx=(x0+x1)/2, L=x1-x0;

  // — chaussée pavée PBR (variant 1, rue standard) ------------------------
  const pave=paveTexture(1);
  pave.map.repeat.set(L/9, w/9);
  pave.roughnessMap.repeat.set(L/9, w/9);
  M3_MAT.road=new THREE.MeshStandardMaterial({
    color:0xa89c80, map:pave.map, roughnessMap:pave.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  const road=new THREE.Mesh(new THREE.PlaneGeometry(L,w), M3_MAT.road);
  road.rotation.x=-Math.PI/2; road.position.set(cx,M3_Y.road,0); road.receiveShadow=true;
  scene.add(road); M3_MESHES.push(road);

  // — caniveau central légèrement creusé (bande sombre humide) -----------
  const can=paveTexture(0);
  can.map.repeat.set(L/8, 1);
  can.roughnessMap.repeat.set(L/8, 1);
  M3_MAT.caniveau=new THREE.MeshStandardMaterial({
    color:0x35302a, map:can.map, roughnessMap:can.roughnessMap,
    roughness:0.55, metalness:0.0,
  });
  const cani=new THREE.Mesh(new THREE.PlaneGeometry(L,1.5), M3_MAT.caniveau);
  cani.rotation.x=-Math.PI/2; cani.position.set(cx,M3_Y.caniveau,0); cani.receiveShadow=true;
  scene.add(cani); M3_MESHES.push(cani);

  // — trottoirs surélevés (h=0.18) en pierre plus claire (variant 2) -----
  const trot=paveTexture(2);
  trot.map.repeat.set(L/8, 3.0/8);
  trot.roughnessMap.repeat.set(L/8, 3.0/8);
  M3_MAT.trottoir=new THREE.MeshStandardMaterial({
    color:0xb8a878, map:trot.map, roughnessMap:trot.roughnessMap,
    roughness:1.0, metalness:0.0,
  });
  for(const sgn of [-1,1]){
    const tw=3.0, tz=sgn*(w/2+tw/2);
    const m=new THREE.Mesh(new THREE.BoxGeometry(L,0.18,tw), M3_MAT.trottoir);
    m.position.set(cx, 0.10, tz); m.receiveShadow=true; m.castShadow=false;
    scene.add(m); M3_MESHES.push(m);
  }

  // — bornes de pierre le long des trottoirs (InstancedMesh : 1 draw call)
  const borneGeo=new THREE.CylinderGeometry(0.34,0.42,0.85,8);
  const borneMat=new THREE.MeshStandardMaterial({color:0x9a9183, roughness:1, flatShading:true});
  const bornes=[];
  for(let bx=x0+8; bx<x1-4; bx+=24){
    for(const sgn of [-1,1]) bornes.push([bx+(sgn>0?5:0), 0.53, sgn*(w/2+2.6)]);
  }
  const borneInst=new THREE.InstancedMesh(borneGeo, borneMat, bornes.length);
  const Mb=new THREE.Matrix4();
  bornes.forEach((b,i)=>{ Mb.makeTranslation(b[0],b[1],b[2]); borneInst.setMatrixAt(i,Mb); });
  borneInst.instanceMatrix.needsUpdate=true;
  borneInst.castShadow=true; borneInst.receiveShadow=false;
  scene.add(borneInst); M3_MESHES.push(borneInst);
}

/* =====================================================================
   M3 — TRANSITIONS DE CLASSE AU SOL.
   Devant chaque zone, un patch sol-overlay raconte la classe sociale :
     banque/bourse/État         → dalles institutionnelles (pavé variant 2)
     marchés / port / quartier  → pavé disjoint sombre (variant 0) + plaques de terre
     terres communes            → terre tassée dorée
     mines                      → terre + voile de poussier noir
   Géométries fusionnées par type (4 draw calls : dalles, disjoint, terre, mines).
   ===================================================================== */
const M3_PATCH_TYPES = {
  dalles:   { zones:['Banque','Bourse','État · Tribunal'],                                    halfW:9, halfD:9 },
  disjoint: { zones:['Marché des moyens','Marché du travail','Marché de vente',
                     'Usine','Entrepôt','Quartier ouvrier','Port · Marché mondial'],          halfW:10, halfD:9 },
  terre:    { zones:['Terres communes'],                                                     halfW:14, halfD:12 },
  mines:    { zones:['Mines · Champs'],                                                      halfW:12, halfD:12 },
};
function _mergePlaneFan(rects, repeatUnit){
  // rects: [{cx, cz, hw, hd}]. UV = (worldX/repeatUnit, worldZ/repeatUnit).
  const pos=[], uv=[], idx=[]; let off=0;
  for(const r of rects){
    const x0=r.cx-r.hw, x1=r.cx+r.hw, z0=r.cz-r.hd, z1=r.cz+r.hd;
    pos.push(x0,0,z0, x1,0,z0, x1,0,z1, x0,0,z1);
    const u=repeatUnit;
    uv.push(x0/u,z0/u, x1/u,z0/u, x1/u,z1/u, x0/u,z1/u);
    // winding inverse pour que la normale calculée pointe vers +Y (face visible du dessus).
    idx.push(off,off+2,off+1, off,off+3,off+2); off+=4;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function buildGroundPatches(){
  const zonePos=name=>{ const z=zones.find(zz=>zz.name===name); return z?z.pos:null; };
  // 1. DALLES (variant 2, plus claires, presque neuves)
  {
    const tex=paveTexture(2);
    M3_MAT.dalles=new THREE.MeshStandardMaterial({
      color:0xbcaa84, map:tex.map, roughnessMap:tex.roughnessMap,
      roughness:1.0, metalness:0.0,
    });
    const rects=[];
    for(const n of M3_PATCH_TYPES.dalles.zones){ const p=zonePos(n); if(p) rects.push({cx:p.x,cz:p.z,hw:9,hd:9}); }
    if(rects.length){
      const m=new THREE.Mesh(_mergePlaneFan(rects, 9), M3_MAT.dalles);
      m.position.y=M3_Y.patches; m.receiveShadow=true;
      scene.add(m); M3_MESHES.push(m);
    }
  }
  // 2. PAVÉ DISJOINT (variant 0, sombre) + plaques de terre éparses
  {
    const tex=paveTexture(0);
    tex.map.repeat.set(1.4,1.4); tex.roughnessMap.repeat.set(1.4,1.4);
    M3_MAT.disjoint=new THREE.MeshStandardMaterial({
      color:0x88796a, map:tex.map, roughnessMap:tex.roughnessMap,
      roughness:1.0, metalness:0.0,
    });
    const rects=[];
    for(const n of M3_PATCH_TYPES.disjoint.zones){
      const p=zonePos(n); if(!p) continue;
      const hw=M3_PATCH_TYPES.disjoint.halfW, hd=M3_PATCH_TYPES.disjoint.halfD;
      rects.push({cx:p.x,cz:p.z,hw,hd});
    }
    if(rects.length){
      const m=new THREE.Mesh(_mergePlaneFan(rects, 7), M3_MAT.disjoint);
      m.position.y=M3_Y.patches; m.receiveShadow=true;
      scene.add(m); M3_MESHES.push(m);
    }
  }
  // 3. TERRE (terres communes)
  {
    const tex=terreTexture();
    tex.map.repeat.set(1.2,1.2); tex.roughnessMap.repeat.set(1.2,1.2);
    M3_MAT.terre=new THREE.MeshStandardMaterial({
      color:0xb7905a, map:tex.map, roughnessMap:tex.roughnessMap,
      roughness:1.0, metalness:0.0,
    });
    const rects=[];
    for(const n of M3_PATCH_TYPES.terre.zones){
      const p=zonePos(n); if(!p) continue;
      const hw=M3_PATCH_TYPES.terre.halfW, hd=M3_PATCH_TYPES.terre.halfD;
      rects.push({cx:p.x,cz:p.z,hw,hd});
    }
    if(rects.length){
      const m=new THREE.Mesh(_mergePlaneFan(rects, 8), M3_MAT.terre);
      m.position.y=M3_Y.patches+0.001; m.receiveShadow=true;
      scene.add(m); M3_MESHES.push(m);
    }
  }
  // 4. MINES — terre dorée + voile de poussier noir (couleur de base assombrie)
  {
    const tex=terreTexture();
    tex.map.repeat.set(1.4,1.4); tex.roughnessMap.repeat.set(1.4,1.4);
    M3_MAT.mines=new THREE.MeshStandardMaterial({
      color:0x4d4030, map:tex.map, roughnessMap:tex.roughnessMap,
      roughness:1.0, metalness:0.0,
    });
    const rects=[];
    for(const n of M3_PATCH_TYPES.mines.zones){
      const p=zonePos(n); if(!p) continue;
      const hw=M3_PATCH_TYPES.mines.halfW, hd=M3_PATCH_TYPES.mines.halfD;
      rects.push({cx:p.x,cz:p.z,hw,hd});
    }
    if(rects.length){
      const m=new THREE.Mesh(_mergePlaneFan(rects, 8), M3_MAT.mines);
      m.position.y=M3_Y.patches+0.002; m.receiveShadow=true;
      scene.add(m); M3_MESHES.push(m);
    }
  }
}

/* =====================================================================
   M3 — FLAQUES RÉFLÉCHISSANTES.
   Les seules surfaces du sol qui ne sont PAS mates : roughness 0.05,
   metalness 0.6, couleur 0x1c2230. Avec l'IBL, elles miroitent le ciel
   doré et serviront d'ancres aux sprites-reflets de lampes en M4.
   Concentration : devant l'usine + dans le quartier ouvrier (drainage
   négligé = détail de classe). Géométries fusionnées : 1 draw call.
   Exporte window.PUDDLES = [{ x, z, r }] pour M4.
   ===================================================================== */
const PUDDLES = [];
function buildPuddles(){
  PUDDLES.length=0;
  // 10 sites : devant l'usine/entrepôt, dans le quartier ouvrier,
  // qq-unes sur la chaussée (où l'eau s'accumule au caniveau).
  const sites=[
    // Usine (-15, 30) — drainage industriel négligé
    {x:-18, z:22, r:2.6}, {x:-10, z:25, r:2.0}, {x:-22, z:38, r:2.8},
    // Entrepôt (18, 32) — flaque devant la rampe
    {x:14, z:24, r:2.2}, {x:22, z:40, r:2.4},
    // Quartier ouvrier (0, 62) — bas-fond, drainage négligé
    {x:-6, z:58, r:3.2}, {x:6, z:66, r:2.6}, {x:-12, z:70, r:2.4},
    // Rue : pluie récente — caniveau qui déborde
    {x:-40, z:3.5, r:1.8}, {x:24, z:-3.2, r:1.6},
  ];
  // M-Polish/C : flaques bien plus IRRÉGULIÈRES. L'ancienne version
  //   utilisait SEG fixe (22) et le même bruit (0.22+0.13+0.08) avec un
  //   seed légèrement décalé → motif répétitif visible d'une flaque à
  //   l'autre. On vient :
  //     - faire varier le nombre de segments par flaque (16..30),
  //     - varier l'orientation initiale (theta0),
  //     - augmenter l'amplitude du bruit + ajouter une harmonique aléatoire,
  //     - varier légèrement la position du centre (excentricité).
  const pos=[], uv=[], idx=[]; let off=0; let seed=13;
  for(const s of sites){
    seed += 7 + Math.floor(Math.abs(s.x*1.3 + s.z*0.7)) % 13;
    const SEG = 16 + (Math.floor(Math.abs(Math.sin(seed*0.3))*15)) % 15;   // 16..30 segs
    const theta0 = (seed * 0.137) % (Math.PI*2);
    const A1 = 0.30 + (Math.abs(Math.sin(seed*0.7))*0.18);                  // ~0.30..0.48
    const A2 = 0.15 + (Math.abs(Math.cos(seed*0.5))*0.10);
    const A3 = 0.06 + (Math.abs(Math.sin(seed*1.2))*0.06);
    const F1 = 3 + Math.floor(Math.abs(Math.sin(seed*0.4))*3);              // 3..5
    const F2 = 5 + Math.floor(Math.abs(Math.cos(seed*0.6))*4);
    const F3 = 7 + Math.floor(Math.abs(Math.sin(seed*0.9))*5);
    // léger décentrage (chaque flaque n'est plus parfaitement circulaire)
    const cx = s.x + Math.sin(seed*0.21) * s.r * 0.06;
    const cz = s.z + Math.cos(seed*0.17) * s.r * 0.06;
    pos.push(cx, 0, cz); uv.push(0.5,0.5);
    for(let i=0;i<SEG;i++){
      const a = theta0 + (i/SEG)*Math.PI*2;
      const noise = 1
        + A1*Math.sin(a*F1 + seed)
        + A2*Math.sin(a*F2 + seed*1.7)
        + A3*Math.sin(a*F3 + seed*0.3);
      const r = s.r*Math.max(0.55, noise);
      pos.push(cx+Math.cos(a)*r, 0, cz+Math.sin(a)*r);
      uv.push(0.5+0.5*Math.cos(a), 0.5+0.5*Math.sin(a));
    }
    // winding inverse : normale vers +Y (reflète le ciel).
    for(let i=0;i<SEG;i++) idx.push(off, off+1+((i+1)%SEG), off+1+i);
    off += SEG+1;
    PUDDLES.push({x:cx, z:cz, r:s.r});
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx);
  g.computeVertexNormals();
  M3_MAT.puddle=new THREE.MeshStandardMaterial({
    color:0x1c2230, roughness:0.05, metalness:0.6, envMapIntensity:1.0,
  });
  const mesh=new THREE.Mesh(g, M3_MAT.puddle);
  mesh.position.y=M3_Y.puddles; mesh.receiveShadow=true;
  scene.add(mesh); M3_MESHES.push(mesh);
  M3_PUDDLE_MESH=mesh;
  if(typeof window!=='undefined'){ window.PUDDLES=PUDDLES; window.PUDDLE_MESH=mesh; }
}

/* =====================================================================
   M3 — DÉBRIS INSTANCIÉS.
   ~80 instances réparties par densité : forte côté quartier ouvrier /
   usine / entrepôt, très faible devant banque/bourse, pierres aux mines.
   3 InstancedMesh = 3 draw calls. Les counts sont écrêtés par la qualité
   (cf. _applyM3Quality).
   ===================================================================== */
function buildGroundDebris(){
  const rnd=_seededRnd(0xdeb7);
  // (cx, cz, rayon dispersion, count, [w_papier, w_éclat, w_pierre])
  const sites=[
    {cx:-15, cz:32, r:13, n:22, types:[0.45,0.30,0.25]},   // usine
    {cx: 18, cz:32, r:11, n:14, types:[0.40,0.30,0.30]},   // entrepôt
    {cx:  0, cz:62, r:18, n:26, types:[0.55,0.20,0.25]},   // quartier ouvrier
    {cx:-72, cz:-25, r: 9, n: 2, types:[0.20,0.20,0.60]},  // banque (quasi rien)
    {cx:-72, cz:-60, r: 9, n: 2, types:[0.20,0.10,0.70]},  // bourse (quasi rien)
    {cx:-105,cz:-62, r:13, n: 8, types:[0.10,0.10,0.80]},  // mines : pierres
    {cx:-105,cz:-30, r:12, n: 6, types:[0.20,0.30,0.50]},  // terres communes
  ];
  const items=[[],[],[]];
  for(const s of sites){
    for(let k=0;k<s.n;k++){
      const a=rnd()*Math.PI*2, d=Math.sqrt(rnd())*s.r;
      const x=s.cx+Math.cos(a)*d, z=s.cz+Math.sin(a)*d;
      const u=rnd();
      const t=(u<s.types[0])?0:(u<s.types[0]+s.types[1])?1:2;
      items[t].push({x, z, rot:rnd()*Math.PI*2, scale:0.7+rnd()*0.7});
    }
  }
  const make=(geo, mat, list, y)=>{
    if(!list.length) return null;
    const inst=new THREE.InstancedMesh(geo, mat, list.length);
    const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion(), S=new THREE.Vector3();
    list.forEach((it,i)=>{
      Q.setFromAxisAngle(new THREE.Vector3(0,1,0), it.rot);
      P.set(it.x, y, it.z); S.set(it.scale,it.scale,it.scale);
      M.compose(P,Q,S); inst.setMatrixAt(i,M);
    });
    inst.instanceMatrix.needsUpdate=true;
    inst.castShadow=false; inst.receiveShadow=true;
    inst.userData.debris=true; inst.userData.maxCount=list.length;
    scene.add(inst); M3_MESHES.push(inst);
    return inst;
  };
  // Papier : plan horizontal d'un blanc-cassé ; double face (vu de dessus)
  const paperGeo=new THREE.PlaneGeometry(0.55,0.4); paperGeo.rotateX(-Math.PI/2);
  const paperMat=new THREE.MeshStandardMaterial({color:0xd8cba8, roughness:0.95, metalness:0, side:THREE.DoubleSide});
  // Éclat : tétraèdre bas (brique cassée)
  const shardGeo=new THREE.TetrahedronGeometry(0.18,0);
  const shardMat=new THREE.MeshStandardMaterial({color:0x7a4530, roughness:0.9, metalness:0, flatShading:true});
  // Pierre : icosaèdre aplati
  const stoneGeo=new THREE.IcosahedronGeometry(0.20,0);
  const stoneMat=new THREE.MeshStandardMaterial({color:0x6e6354, roughness:1, metalness:0, flatShading:true});
  M3_DEBRIS=[
    make(paperGeo, paperMat, items[0], M3_Y.paperDebris),
    make(shardGeo, shardMat, items[1], M3_Y.shardDebris),
    make(stoneGeo, stoneMat, items[2], M3_Y.stoneDebris),
  ].filter(Boolean);
}

function _applyM3Quality(q){
  // Basse : flaques mates (pas de réflexion), débris réduits (~35%).
  // Moyenne : débris à 70%. Haute : 100%.
  if(M3_MAT.puddle){
    if(q==='low'){
      M3_MAT.puddle.roughness=1.0; M3_MAT.puddle.metalness=0.0;
      M3_MAT.puddle.envMapIntensity=0.0;
    } else {
      M3_MAT.puddle.roughness=0.05; M3_MAT.puddle.metalness=0.6;
      M3_MAT.puddle.envMapIntensity=1.0;
    }
    M3_MAT.puddle.needsUpdate=true;
  }
  const factor = q==='low'?0.35 : q==='medium'?0.7 : 1.0;
  for(const m of M3_DEBRIS){
    if(!m) continue;
    const max=m.userData.maxCount|0;
    m.count=Math.max(1, Math.floor(max*factor));
  }
}
if(typeof window!=='undefined') window._applyM3Quality=_applyM3Quality;
/* v61 — drawCircuitLine supprimée : le tube doré permanent encombrait la lecture. */

/* ===================================================================
   Vehicle  —  chariot industriel, physique arcade (pas de Rapier ici)
   =================================================================== */
const Vehicle = {
  group:null, cargoGroups:null, puff:null, wheels:[],
  pos:new THREE.Vector3(-95,0,2), heading:Math.PI/2, speed:0,   // v52 : on arrive de la campagne, par la rue
  build(){
    const g=new THREE.Group();
    // M-Peaufinage/C : matériaux partagés (utilisés à plusieurs endroits :
    //   caisse, cargaisons, cerclages des roues). Déclarés ici en haut
    //   pour éviter tout TDZ — ils sont créés UNE fois.
    const matCerclage=new THREE.MeshStandardMaterial({color:0x1a1410, metalness:.6, roughness:.4, flatShading:true});
    const matPlanche=new THREE.MeshStandardMaterial({color:0x4a382a, roughness:0.95, flatShading:true});
    // --- plateforme / châssis ---
    g.add(box(3.2,0.3,4.8,COL.encre,0,0.45,0,false));     // dessous de châssis
    const plateau=box(3,0.5,4.6,0x3a332a,0,0.78,0); addOutline(plateau); g.add(plateau);              // plateau
    // ridelles autour du plateau
    g.add(box(3,0.7,0.18,COL.brun,0,1.35,-2.2));          // ridelle avant
    g.add(box(0.18,0.7,4.4,COL.brun,-1.5,1.35,0));        // ridelle gauche
    g.add(box(0.18,0.7,4.4,COL.brun,1.5,1.35,0));         // ridelle droite
    // bloc moteur + conduite à l'arrière (chariot "industriel motorisé")
    g.add(box(2.4,1.1,1.2,0x2f2a22,0,1.45,2.1));          // bloc moteur
    g.add(box(0.9,1.5,0.4,0x1f1b15,0,2.1,2.55));          // colonne de direction
    g.add(box(0.4,1.5,0.4,0x33302a,0.85,2.1,2.5));        // cheminée d'échappement
    this.puff=new THREE.Mesh(new THREE.SphereGeometry(0.5,8,8),
      new THREE.MeshStandardMaterial({color:0x8a8275,transparent:true,opacity:.3,flatShading:true}));
    this.puff.position.set(0.85,3.05,2.5); g.add(this.puff);
    // v62 — lanterne d'avant : potence + verre émissif + halo lumineux projeté au sol (la nuit)
    g.add(box(0.1,0.9,0.1,0x2a241c,0,1.7,-2.35,false));
    const verre=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.42,0.34),
      new THREE.MeshStandardMaterial({color:0x6b5530,emissive:0xffc878,emissiveIntensity:0,flatShading:true}));
    verre.position.set(0,2.2,-2.35); g.add(verre); this.lampGlass=verre;
    const haloTex=(()=>{ const c=document.createElement('canvas'); c.width=c.height=128;
      const x=c.getContext('2d'); const gr=x.createRadialGradient(64,72,4,64,72,60);
      gr.addColorStop(0,'rgba(255,206,128,0.55)'); gr.addColorStop(1,'rgba(255,206,128,0)');
      x.fillStyle=gr; x.fillRect(0,0,128,128); return new THREE.CanvasTexture(c); })();
    this.lampPool=new THREE.Mesh(new THREE.PlaneGeometry(7,9),
      new THREE.MeshBasicMaterial({map:haloTex,transparent:true,opacity:0,depthWrite:false}));
    this.lampPool.rotation.x=-Math.PI/2; this.lampPool.position.set(0,0.03,-5.2); g.add(this.lampPool);
    // M-Peuple-détail-b : COCHER du chariot — figure procédurale animée
    //   en 'drive' (bras tendus en avant tenant les rênes, légère
    //   oscillation idle). Posé à l'avant-motion du chariot (local z=+1.55).
    //   PARENTÉ au chariot via g.add(drv) : il suit position et rotation
    //   EXACTEMENT, ne glisse pas, ne tremble pas. Échelle réduite (0.85)
    //   pour ne pas masquer la lanterne ni l'UI. Visible dans toutes les
    //   caméras (Carte, Épaule, Immersion).
    //   baseY mis à jour APRÈS positionnement : sinon _animate écraserait
    //   fig.position.y à 0 chaque frame (bug de sautillement).
    //   ORIENTATION : la marche du chariot suit (sin(heading), cos(heading))
    //   qui correspond au LOCAL +Z une fois group.rotation.y = heading
    //   appliqué. Or buildFigure fait regarder vers +Z à rotation.y = 0
    //   (visière de casquette au +Z). → rotation.y = 0 pour que le cocher
    //   fasse FACE à la route ; son dos est alors tourné vers la caméra
    //   de suivi (placée derrière à pos - (dx, dz)*back).
    const drv = spawnFigure({ type:'ouvrier', anim:'drive', tint:0x8a3b2a });
    drv.position.set(0,0.42,1.55); drv.rotation.y=0;
    drv.scale.setScalar(0.85);
    drv.userData.baseY = 0.42;
    g.add(drv); this.driver=drv;

    // --- les trois cargaisons (une seule visible à la fois) ---
    //   M-Peaufinage/C : marchandises mieux modelées (cerclages, piles
    //   de pièces, charbon en tas, sacs plus crédibles).
    const bY=1.1, bZ=-0.3;
    const argent=new THREE.Group();
    const ingot=(x,z)=>argent.add(box(0.95,0.34,0.62,COL.or,x,bY+0.17,bZ+z));
    ingot(-0.5,-0.5);ingot(0.5,-0.5);ingot(0,0.35);
    argent.add(box(0.95,0.34,0.62,0xc9a85e,0,0.17+bY+0.34,bZ-0.5));               // lingot empilé
    // pile de PIÈCES (4 fins disques empilés) — la valeur s'incarne
    const matCoin = new THREE.MeshStandardMaterial({color:COL.or, metalness:.55, roughness:.30, flatShading:true});
    for(let i=0;i<4;i++){
      const c=new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 14), matCoin);
      c.position.set(0.40, bY+0.05 + i*0.05, bZ+0.95);
      argent.add(c);
    }
    // sacs (deux dômes aplatis)
    [[-0.55,0.7],[0.6,0.6]].forEach(([x,z])=>{
      const s=new THREE.Mesh(new THREE.SphereGeometry(0.5,8,6),
        new THREE.MeshStandardMaterial({color:0xb9a06a,flatShading:true}));
      s.scale.set(1,0.85,1); s.position.set(x,bY+0.42,bZ+z); argent.add(s);
    });

    const moyens=new THREE.Group();
    // charbon en TAS : un cône principal + 4 morceaux noirs autour
    const matCharbon = new THREE.MeshStandardMaterial({color:COL.charbon, roughness:1, flatShading:true});
    const coal=new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.05, 7), matCharbon);
    coal.position.set(-0.55,bY+0.5,bZ-0.4); moyens.add(coal);
    for(let i=0;i<4;i++){
      const a=i*Math.PI/2 + 0.5;
      const chunk=new THREE.Mesh(new THREE.IcosahedronGeometry(0.18+Math.random()*0.10, 0), matCharbon);
      chunk.position.set(-0.55+Math.cos(a)*0.55, bY+0.18, bZ-0.4+Math.sin(a)*0.45);
      moyens.add(chunk);
    }
    // caisse matière avec cerclages
    const matBoisCaisse=new THREE.MeshStandardMaterial({color:0x8a6b49, roughness:0.95, flatShading:true});
    const caisse1=new THREE.Mesh(new THREE.BoxGeometry(0.95,0.95,0.95), matBoisCaisse);
    caisse1.position.set(0.6, bY+0.48, bZ-0.3); moyens.add(caisse1);
    for(const dy of [-0.36, 0.36]){
      const band=new THREE.Mesh(new THREE.BoxGeometry(0.99, 0.06, 0.99), matCerclage);
      band.position.set(0.6, bY+0.48+dy, bZ-0.3); moyens.add(band);
    }
    // balle de coton (texture moelleuse — sphère un peu écrasée)
    const cotton=new THREE.Mesh(new THREE.SphereGeometry(0.48, 8, 6),
      new THREE.MeshStandardMaterial({color:0xcdbd9a, roughness:0.95, flatShading:true}));
    cotton.scale.set(1, 0.85, 1.1);
    cotton.position.set(0.5, bY+0.46, bZ+0.8); moyens.add(cotton);
    moyens.add(box(0.85,0.8,0.85,0x8a8076, -0.6, bY+0.4, bZ+0.85));                // fer brut

    const march=new THREE.Group();
    const crate=(x,z,y)=>{
      // caisse en planches : corps + 2 cerclages + nervures
      const body=new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.86, 0.88), matBoisCaisse);
      body.position.set(x, bY+0.43+y, bZ+z); march.add(body);
      march.add(box(0.9, 0.13, 0.9, 0x7a4530, x, bY+0.85+y, bZ+z, false));        // couvercle
      // cerclages fer
      for(const dy of [-0.30, 0.30]){
        const band=new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.92), matCerclage);
        band.position.set(x, bY+0.43+y+dy, bZ+z); march.add(band);
      }
    };
    crate(-0.5,-0.45,0);crate(0.5,-0.45,0);crate(-0.5,0.5,0);crate(0.5,0.5,0);crate(0,0.02,0.95);
    this.cargoGroups={argent,moyens,marchandises:march};
    Object.values(this.cargoGroups).forEach(grp=>g.add(grp));

    // --- roues : jante + moyeu + 8 rayons + ferrures, grandes à l'arrière ---
    //   M-Peaufinage/C : 8 rayons au lieu de 4, ferrures (boulons) sur la
    //   jante, jante un peu plus fine — silhouette nettement plus riche
    //   sans changer le rayon ni le pivot (les roues continuent de tourner
    //   correctement via wheels[].rotation.x).
    const wmat=new THREE.MeshStandardMaterial({color:0x201c16,flatShading:true});
    const hubMat=new THREE.MeshStandardMaterial({color:COL.fer,metalness:.4,roughness:.5,flatShading:true});
    const boltMat=new THREE.MeshStandardMaterial({color:0x4a4236,metalness:.6,roughness:.4,flatShading:true});
    const addWheel=(x,z,r)=>{
      const tire=new THREE.Mesh(new THREE.CylinderGeometry(r,r,0.40,18), wmat);
      // moyeu en fer + rondelle
      const hub=new THREE.Mesh(new THREE.CylinderGeometry(r*0.34, r*0.34, 0.46, 12), hubMat);
      tire.add(hub);
      const ring=new THREE.Mesh(new THREE.CylinderGeometry(r*0.42, r*0.42, 0.10, 14), boltMat);
      tire.add(ring);
      // 8 rayons (au lieu de 4) — 4 par moitié → silhouette dense
      for(let i=0;i<8;i++){
        const sp=new THREE.Mesh(new THREE.BoxGeometry(r*1.65, 0.06, 0.09), wmat);
        sp.rotation.y=i*Math.PI/8;
        tire.add(sp);
      }
      // 6 ferrures (boulons en fer) sur la face de la jante
      for(let i=0;i<6;i++){
        const a=i*Math.PI/3;
        const bolt=new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.045,0.10,6), boltMat);
        bolt.position.set(0, 0, 0);
        bolt.rotation.x=0;
        // décale en (x,z) dans le plan de la jante (tire est orienté autour de Y local AVANT rotation finale)
        bolt.position.x=Math.cos(a)*r*0.78;
        bolt.position.z=Math.sin(a)*r*0.78;
        tire.add(bolt);
      }
      tire.rotation.z=Math.PI/2; tire.position.set(x,r,z); g.add(tire); this.wheels.push(tire);
    };
    addWheel(-1.6,1.7,0.8); addWheel(1.6,1.7,0.8);        // arrière
    addWheel(-1.45,-1.7,0.54); addWheel(1.45,-1.7,0.54);  // avant
    // essieux + garde-boue
    for(const z of[1.7,-1.7]){ const ax=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,3.4,8),hubMat); ax.rotation.z=Math.PI/2; ax.position.set(0,z>0?0.8:0.54,z); g.add(ax); }
    for(const x of[-1.6,1.6]) g.add(box(1.5,0.18,0.5,0x2f2a22,x,1.55,1.7,false));   // garde-boue arrière

    // --- M-Peaufinage/C : CAISSE EN PLANCHES (clous + cerclages fer)
    //   sur les flancs de la caisse. Donne le toucher de menuiserie au
    //   chariot, en restant low-poly (boxes fines superposées).
    //   matPlanche/matCerclage déclarés en haut de build().
    // 5 planches verticales sur chaque flanc, légèrement décalées en x.
    for(const sx of [-1, 1]){
      for(let k=0;k<5;k++){
        const px = -2.0 + k*0.92;          // -2.0..+1.68
        const pl=new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.62, 0.03), matPlanche);
        pl.position.set(sx*1.51, 1.30, px);
        pl.rotation.y=sx>0 ? -Math.PI/2 : Math.PI/2;
        g.add(pl);
      }
      // 2 cerclages fer horizontaux (haut/bas)
      for(const py of [1.05, 1.55]){
        const cz=new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 4.0), matCerclage);
        cz.position.set(sx*1.55, py, 0);
        g.add(cz);
      }
      // clous (4 par flanc — décoratif)
      for(let i=0;i<4;i++){
        const py = i<2 ? 1.05 : 1.55;
        const pz = -1.6 + (i%2)*3.2;
        const cl=new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), matCerclage);
        cl.position.set(sx*1.56, py, pz);
        g.add(cl);
      }
    }

    // --- M-Peuple/C : CHAUDIÈRE À VAPEUR au-dessus du bloc moteur ---
    //   Cylindre horizontal en fer (le « moteur du capital »), petit
    //   manomètre, cheminée déjà présente. Ce volume rappelle visuellement
    //   que le chariot est une MACHINE — qu'il tourne, qu'il chauffe.
    const matChaudiere=new THREE.MeshStandardMaterial({color:0x46362a, metalness:.35, roughness:.55, flatShading:true});
    const matIronShiny=new THREE.MeshStandardMaterial({color:0x6b6155, metalness:.7, roughness:.35, flatShading:true});
    const chaudiere=new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.6, 12), matChaudiere);
    chaudiere.rotation.z=Math.PI/2;
    chaudiere.position.set(0, 2.20, 2.10); g.add(chaudiere);
    // 3 cerclages fer brillant
    for(const cx of [-0.55, 0, 0.55]){
      const band=new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.06, 12), matIronShiny);
      band.rotation.z=Math.PI/2;
      band.position.set(cx, 2.20, 2.10); g.add(band);
    }
    // petit manomètre rond (juste devant la chaudière)
    const dial=new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.04, 10), matIronShiny);
    dial.rotation.x=Math.PI/2;
    dial.position.set(0.62, 2.20, 1.30); g.add(dial);
    // valve (petite molette en haut de la chaudière)
    const valve=new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.20, 8), matIronShiny);
    valve.position.set(0, 2.55, 2.10); g.add(valve);
    const handle=new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.025, 4, 12), matIronShiny);
    handle.position.set(0, 2.66, 2.10); handle.rotation.x=Math.PI/2; g.add(handle);

    // lanterne avant (le capital éclaire sa propre route)
    this.lantern=new THREE.Mesh(new THREE.SphereGeometry(0.34,10,10),
      new THREE.MeshStandardMaterial({color:0xffdf9a,emissive:0xffb347,emissiveIntensity:.9,flatShading:true}));
    this.lantern.position.set(0,1.7,-2.35); g.add(this.lantern);
    g.add(box(0.22,0.5,0.22,COL.fer,0,1.35,-2.35,false));   // potence de lanterne
    // halo au sol : or (argent transporté) / rouge (crise, dette)
    this.glow=new THREE.Mesh(new THREE.RingGeometry(2.0,3.6,28),
      new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:.0,side:THREE.DoubleSide,depthWrite:false}));
    this.glow.rotation.x=-Math.PI/2; this.glow.position.y=0.12; g.add(this.glow);

    // emblème du capital (£) sur le flanc
    const plaque=makeLabel('£'); plaque.scale.set(2.1,1.05,1); plaque.position.set(0,2.7,0.4); g.add(plaque);
    // poussière au sol (pool)
    this.dust=[]; this._dustT=0;
    for(let i=0;i<6;i++){ const d=new THREE.Mesh(new THREE.SphereGeometry(0.42,6,6),
      new THREE.MeshStandardMaterial({color:0xb9ad90,transparent:true,opacity:0,flatShading:true}));
      d.visible=false; scene.add(d); this.dust.push({obj:d,life:0}); }

    g.traverse(o=>{if(o.isMesh)o.castShadow=true;});
    this.group=g; scene.add(g);
    this.reset();
  },
  reset(){ this.pos.set(-95,0,2); this.heading=Math.PI/2; this.speed=0; },
  update(dt,input){
    const ACCEL=42, MAXF=26, MAXR=12, TURN=2.4;
    if(input.fwd) this.speed+=ACCEL*dt;
    if(input.back) this.speed-=ACCEL*dt;
    if(!input.fwd && !input.back) this.speed*=Math.pow(0.12,dt); // frein moteur
    this.speed=Math.max(-MAXR,Math.min(MAXF,this.speed));
    const grip=Math.min(1,Math.abs(this.speed)/2.5);
    if(input.left)  this.heading+=TURN*dt*grip*Math.sign(this.speed||1);
    if(input.right) this.heading-=TURN*dt*grip*Math.sign(this.speed||1);

    const nx=this.pos.x+Math.sin(this.heading)*this.speed*dt;
    const nz=this.pos.z+Math.cos(this.heading)*this.speed*dt;
    // collisions simples (cercles) + bornes
    let blocked=false;
    for(const o of obstacles){ if((nx-o.pos.x)**2+(nz-o.pos.z)**2 < (o.radius+1.6)**2){blocked=true;break;} }
    if(!blocked && Math.abs(nx)<HALF-2 && Math.abs(nz)<HALF-2){ this.pos.x=nx; this.pos.z=nz; }
    else this.speed*=-0.25;

    // v63 — la caisse VIT : trépidation de pavés à la vitesse, roulis dans les
    // virages, tangage à l'accélération/freinage. Pure cosmétique, zéro physique.
    const vRatio=Math.min(1,Math.abs(this.speed)/9);
    this.group.position.set(this.pos.x, 0.045*Math.sin(t*13)*vRatio, this.pos.z);
    this.group.rotation.y=this.heading;
    const lean=(input.left?1:input.right?-1:0)*grip*0.2;
    this.group.rotation.z=THREE.MathUtils.lerp(this.group.rotation.z||0,lean,0.18);
    const accel=(input.fwd?1:0)-(input.back?1:0);
    this._pitch=THREE.MathUtils.lerp(this._pitch||0, -accel*0.05*grip, 0.12);
    this.group.rotation.x=this._pitch;
    if(this.driver) this.driver.rotation.z=-this.group.rotation.z*1.6;   // le conducteur compense le roulis
    const spin=this.speed*dt*1.6; this.wheels.forEach(w=>w.rotation.x+=spin);
    // afficher la cargaison correspondant à ce que transporte le capital
    if(this.cargoGroups){ const cg=MiniCircuit.cargo;
      for(const k in this.cargoGroups) this.cargoGroups[k].visible=(k===cg); }
    // panache d'échappement selon la vitesse
    if(this.puff){ const v=Math.abs(this.speed);
      this.puff.material.opacity=0.18+Math.min(0.5,v/26);
      this.puff.scale.setScalar(0.7+Math.min(0.9,v/18)); }
    // identité réactive : or quand le capital est argent, rouge sous tension
    const stress=Math.max((state.d&&state.d.declenche)?1:0,
      Math.min(1,((state.d&&state.d.risqueCrise)||0)),
      Math.min(1,(state.dette||0)/400));
    if(this.glow){
      const gold=MiniCircuit.cargo==='argent';
      const pulse=0.5+0.5*Math.sin(t*3);
      if(stress>0.35){ this.glow.material.color.setHex(COL.rouge);
        this.glow.material.opacity=(0.18+0.30*stress)*pulse; }
      else { this.glow.material.color.setHex(COL.or);
        this.glow.material.opacity=(gold?0.30:0.10)*(0.6+0.4*pulse); }
    }
    if(this.lantern){ const stressed=stress>0.35;
      this.lantern.material.emissive.setHex(stressed?0x8a2c1d:0xffb347);
      // M1c — veilleuse calibrée ≤ 1.2 : discrète le jour, douce la nuit, pulse rouge en stress.
      const _nightF=(typeof DayCycle!=='undefined')?Math.max(0,1-DayCycle.kDay*1.7):0.5;
      const _pulse=0.5+0.5*Math.sin(t*4);
      this.lantern.material.emissiveIntensity=0.15+_nightF*(0.55+0.15*_pulse)+(stressed?0.30*_pulse:0); }
    // traînée de poussière à vitesse + vibration moteur à l'arrêt
    if(this.dust){ this._dustT-=dt;
      if(Math.abs(this.speed)>8 && this._dustT<=0){ this._dustT=0.08;
        const d=this.dust.find(x=>!x.obj.visible);
        if(d){ d.obj.visible=true; d.life=0;
          d.obj.position.set(this.pos.x-Math.sin(this.heading)*2.3,0.3,this.pos.z-Math.cos(this.heading)*2.3); } }
      for(const d of this.dust){ if(!d.obj.visible) continue; d.life+=dt;
        if(d.life>0.7){ d.obj.visible=false; continue; }
        d.obj.position.y+=dt*1.2; d.obj.scale.setScalar(0.6+d.life*2.2);
        d.obj.material.opacity=0.42*(1-d.life/0.7); } }
    this.group.position.y = (Math.abs(this.speed)<0.4) ? Math.sin(t*38)*0.025 : 0;
  }
};

/* ===================================================================
   CameraController  —  caméra de poursuite
   =================================================================== */
/* =====================================================================
   M-POV — CAMÉRA IMMERSIVE RÉGLABLE.
   3 presets commutables (touche C) — la lisibilité reste défaut.
     map       : haute, lisible (vue actuelle, défaut).
     shoulder  : mi-hauteur, plongée modérée — compromis.
     immersion : basse hauteur d'essieu, le monde pèse.
   Transitions douces (lerp position + lookAt smooth) — pas de saut.
   FOV s'ajuste à chaque preset ; en Immersion, plus large pour accentuer
   la profondeur et l'écrasement du soleil rasant.
   ===================================================================== */
const CAM_PRESETS = {
  map:       { fov:55, back:22,  up:13.2, dynBack:5.5, dynUp:2.0, lookFwd:6,  lookY:5.2, posLerp:0.07, lookLerp:1.00 },
  // « Épaule » — DÉFAUT : médian entre l'ancienne épaule et l'immersion.
  // Caméra mi-basse, regard projeté plus loin, FOV plus large que la carte.
  shoulder:  { fov:60, back:10.5,up:4.5,  dynBack:2.2, dynUp:0.7, lookFwd:13, lookY:2.9, posLerp:0.10, lookLerp:0.17 },
  immersion: { fov:62, back:7.5, up:2.2,  dynBack:1.4, dynUp:0.4, lookFwd:16, lookY:2.6, posLerp:0.11, lookLerp:0.15 },
};
const _CAM_ORDER = ['map', 'shoulder', 'immersion'];
// Démarre sur le nouveau « entre-deux » (shoulder). C cycle vers immersion,
// puis carte, puis revient à shoulder.
let CAM_MODE = 'shoulder';
const CameraController = {
  _smoothLook: new THREE.Vector3(),
  _initLook: false,
  _desired: new THREE.Vector3(),
  _target: new THREE.Vector3(),
  setMode(mode){
    if(!CAM_PRESETS[mode]) return;
    CAM_MODE = mode;
    pushLog('Caméra', 'Vue : '+(mode==='map'?'Carte':mode==='shoulder'?'Épaule':'Immersion')+'.', 'plain');
  },
  cycleMode(){
    const idx=_CAM_ORDER.indexOf(CAM_MODE);
    this.setMode(_CAM_ORDER[(idx+1)%_CAM_ORDER.length]);
  },
  update(){
    if(typeof CycleCinematic!=='undefined' && CycleCinematic.active){ CycleCinematic.update(); return; }
    // M-Cinéma : pendant une séquence scriptée, le moteur cinéma possède la
    // caméra entièrement (positions + lookAt par spline). On rend la main au
    // mode M-POV courant dès que la séquence se termine ou que le joueur skip.
    if(typeof CinemaMode!=='undefined' && CinemaMode.isActive()){ return; }
    const v=Vehicle;
    const cfg=CAM_PRESETS[CAM_MODE];
    const sp=Math.min(1, Math.abs(v.speed)/26);
    const back=cfg.back + sp*cfg.dynBack, up=cfg.up + sp*cfg.dynUp;
    const dx=Math.sin(v.heading), dz=Math.cos(v.heading);
    this._desired.set(v.pos.x - dx*back, up, v.pos.z - dz*back);
    camera.position.lerp(this._desired, cfg.posLerp);
    // Garde-fou : ne descend jamais sous le niveau du sol.
    if(camera.position.y < 0.8) camera.position.y = 0.8;

    // LookAt avec lissage (vraie inertie en mode bas, instantané en mode carte).
    this._target.set(v.pos.x + dx*cfg.lookFwd, cfg.lookY, v.pos.z + dz*cfg.lookFwd);
    if(!this._initLook){ this._smoothLook.copy(this._target); this._initLook=true; }
    if(cfg.lookLerp >= 1){
      this._smoothLook.copy(this._target);
    } else {
      this._smoothLook.lerp(this._target, cfg.lookLerp);
    }
    camera.lookAt(this._smoothLook);

    // FOV transition continue.
    if(Math.abs(camera.fov - cfg.fov) > 0.05){
      camera.fov += (cfg.fov - camera.fov) * 0.08;
      camera.updateProjectionMatrix();
    }

    // Indicateur de bord d'écran (garde-fou lisibilité en POV bas) :
    // pointe vers la cible si elle est hors champ ou cachée par un mur.
    _M_POV_updateTargetIndicator();
  }
};

/* =====================================================================
   M-Cinéma — MOTEUR DE SÉQUENCE CONTEMPLATIVE.
   Prend la main sur la caméra pour un travelling scripté par splines
   Catmull-Rom (camP[] + targetP[] + durée + titre). Pendant la séquence :
     • caméra suivie le long des splines (ease-in-out global, lissage),
     • barres letterbox haut/bas en fondu (CSS),
     • HUD de jeu masqué en fondu (class 'cinema-on' sur body),
     • temps de simulation ralenti (timeScale réglable, défaut 0.35),
     • DoF prononcé (BokehPass aperture/maxblur montés ; focus = sujet),
     • grain renforcé (GradeShader.uGrain ×2.5).
   ESC ou clic = skip ; retour au gameplay PROPRE (caméra rendue au M-POV
   courant, HUD restauré, time scale = 1, DoF/grain remis à leurs niveaux
   de jeu).
   LECTURE SEULE de la simulation. Pas d'écriture, pas de mutation d'état.
   ===================================================================== */
const CinemaMode = (function(){
  let active = false;
  let _t = 0, _dur = 1;
  let _pathCam = null, _pathTar = null;
  let _title = '', _onEnd = null;
  let _timeScaleTarget = 1;
  let _timeScale = 1;                  // valeur lissée (entrée/sortie progressives)
  let _fadeIn = 0.6, _fadeOut = 0.6;   // s — montée/descente des effets
  let _fov = null;                     // FOV ciblé pendant la séquence (null = conserver)
  let _baseGrain = 0.025;
  // M-Cinéma-b/C : valeurs « de jeu » — DoF NEUTRE (aperture/maxblur = 0).
  //   En sortie de cinéma on remet ces valeurs ET on coupe bokehPass.enabled.
  let _baseFocus = 34.0, _baseAperture = 0, _baseMaxBlur = 0;
  let _domReady = false;
  let _topBar=null, _bottomBar=null, _titleEl=null;
  // scratch
  const _tmpP = new THREE.Vector3();
  const _tmpT = new THREE.Vector3();
  // Pour ramener proprement le ralenti à 1 quand la séquence se termine
  // (skip ou naturel) : on continue de lisser pendant ~0.5 s après end().
  let _coolDownT = 0;

  function _ensureDom(){
    if(_domReady) return;
    // INJECTION CSS (une seule fois)
    const css = document.createElement('style');
    css.id = 'mcinema-style';
    css.textContent = `
      .mcinema-letterbox {
        position: fixed; left: 0; right: 0;
        background: #000; pointer-events: none; z-index: 50;
        opacity: 0; transition: opacity .6s ease;
      }
      .mcinema-letterbox.top    { top: 0;    height: 12vh; }
      .mcinema-letterbox.bottom { bottom: 0; height: 12vh; }
      body.mcinema-on .mcinema-letterbox { opacity: 1; }
      /* M-Cinéma-b/B : MASQUE GLOBAL de toute l'UI de jeu pendant une
         séquence cinéma. On veut un écran PROPRE : letterbox + scène
         + titre éventuel. Tout le reste s'éteint en fondu (transition
         .6 s pour rester cohérent avec le letterbox). */
      body.mcinema-on .hud,
      body.mcinema-on .circuit,
      body.mcinema-on #circuit,
      body.mcinema-on .crisisTag,
      body.mcinema-on #pov-target-indicator,
      body.mcinema-on #circuit-panel,
      body.mcinema-on .panel,
      body.mcinema-on .coach,         /* TUTORIEL */
      body.mcinema-on #tutorial-coach,
      body.mcinema-on .quest,
      body.mcinema-on #quest,
      body.mcinema-on .formation,
      body.mcinema-on #formation,
      body.mcinema-on .log,
      body.mcinema-on #log,
      body.mcinema-on .villebadge,
      body.mcinema-on #villebadge,
      body.mcinema-on .whap,
      body.mcinema-on .resolve-hint,
      body.mcinema-on .tuto-focus,
      body.mcinema-on .prompt,
      body.mcinema-on #qa,
      body.mcinema-on #chantier-btn,
      body.mcinema-on #log-open,
      body.mcinema-on .zoneact,
      body.mcinema-on #flash,
      body.mcinema-on #crisisVeil { opacity: 0 !important; pointer-events: none !important; transition: opacity .6s ease; }
      .mcinema-title {
        position: fixed; left: 0; right: 0; bottom: 14vh;
        text-align: center; z-index: 51;
        color: #e9ddc6; opacity: 0; transition: opacity .8s ease;
        font: 600 22px/1.4 "Cormorant Garamond", "Zilla Slab", serif;
        letter-spacing: 0.06em; text-shadow: 0 2px 8px rgba(0,0,0,0.85);
        pointer-events: none;
      }
      body.mcinema-on .mcinema-title { opacity: 0.92; }
      .mcinema-skip {
        position: fixed; right: 14px; bottom: 13vh; z-index: 52;
        color: #c9b78c; opacity: 0; transition: opacity .8s ease;
        font: 500 11px/1 "IBM Plex Mono", monospace; letter-spacing: 0.10em;
        pointer-events: none;
      }
      body.mcinema-on .mcinema-skip { opacity: 0.65; }
    `;
    document.head.appendChild(css);
    _topBar    = document.createElement('div'); _topBar.className='mcinema-letterbox top';
    _bottomBar = document.createElement('div'); _bottomBar.className='mcinema-letterbox bottom';
    _titleEl   = document.createElement('div'); _titleEl.className='mcinema-title';
    const skipEl = document.createElement('div'); skipEl.className='mcinema-skip'; skipEl.textContent='ESC / clic — passer';
    document.body.appendChild(_topBar);
    document.body.appendChild(_bottomBar);
    document.body.appendChild(_titleEl);
    document.body.appendChild(skipEl);
    // Skip handlers — uniquement ACTIFS pendant le mode cinéma.
    window.addEventListener('keydown', e => {
      if(active && (e.code === 'Escape' || e.code === 'Space')){ e.preventDefault(); skip(); }
    });
    window.addEventListener('mousedown', () => { if(active) skip(); }, true);
    window.addEventListener('touchstart', () => { if(active) skip(); }, { capture: true, passive: true });
    _domReady = true;
  }

  /* spec :
     { camPath:   [Vector3, ...]   ≥ 2 points
       targetPath:[Vector3, ...]   même cardinal (ou 1 cible fixe)
       duration:  Number (s)       défaut 6.5
       title:     String           ligne de bas d'écran (peut être '')
       timeScale: Number 0..1      défaut 0.35
       fov:       Number           FOV cible pendant la séquence (null = conserver)
       onEnd:     Function         appelée à end() (skip ou fin naturelle) }
  */
  function begin(spec){
    if(active) return false;
    _ensureDom();
    if(!spec || !spec.camPath || spec.camPath.length < 2) return false;
    active = true;
    _t = 0;
    _dur = Math.max(0.5, spec.duration || 6.5);
    _title = spec.title || '';
    _timeScaleTarget = (spec.timeScale != null) ? spec.timeScale : 0.35;
    // _timeScale n'est PAS remis à 1 brutalement : on part de sa valeur
    //   courante (probablement 1 sauf rejouage rapide) et on lisse vers
    //   _timeScaleTarget pendant le fadeIn — entrée parfaitement douce.
    _onEnd = spec.onEnd || null;
    _coolDownT = 0;
    _fov = (spec.fov != null) ? spec.fov : null;
    // splines Catmull-Rom (centripetal → pas de boucles en virage), closed=false.
    _pathCam = new THREE.CatmullRomCurve3(spec.camPath, false, 'centripetal', 0.5);
    let targetPts = spec.targetPath;
    if(!targetPts || targetPts.length < 2){
      // pas de spline cible → cible fixe répétée (compatible avec getPoint)
      const fixed = (targetPts && targetPts[0]) || new THREE.Vector3(0,0,0);
      targetPts = [fixed.clone(), fixed.clone()];
    }
    _pathTar = new THREE.CatmullRomCurve3(targetPts, false, 'centripetal', 0.5);
    // Bascule l'UI en mode cinéma — CSS s'occupe des fondus.
    document.body.classList.add('mcinema-on');
    if(_titleEl) _titleEl.textContent = _title;
    // M-Cinéma-b/C : ACTIVE le DoF (BokehPass) seulement maintenant.
    //   En jeu normal il reste désactivé → zéro flou résiduel possible.
    //   On respecte la qualité 'low' (jamais de DoF en basse qualité).
    if(bokehPass && (typeof RENDER_QUALITY === 'undefined' || RENDER_QUALITY !== 'low')){
      bokehPass.enabled = true;
    }
    return true;
  }

  function skip(){ if(active) end(); }

  // M-Cinéma-b/C : CHEMIN UNIQUE DE SORTIE. Skip OU fin naturelle passent
  //   ici. Tous les effets sont remis à leur état de jeu, garanti.
  //   Pas de cas où on quitte un mode cinéma sans nettoyer.
  function end(){
    if(!active) return;
    active = false;
    document.body.classList.remove('mcinema-on');
    if(_titleEl) _titleEl.textContent = '';
    // Grain → niveau de jeu.
    if(gradePass) gradePass.uniforms.uGrain.value = _baseGrain;
    // DoF → COMPLÈTEMENT désactivé (enabled=false + uniforms à zéro).
    //   C'est la garantie qu'il n'y a JAMAIS de flou résiduel en jeu.
    if(bokehPass){
      bokehPass.uniforms.focus.value    = _baseFocus;
      bokehPass.uniforms.aperture.value = _baseAperture;
      bokehPass.uniforms.maxblur.value  = _baseMaxBlur;
      bokehPass.enabled = false;
    }
    // Ralenti REMONTE en douceur vers 1 (cf. _coolDownT dans update).
    _timeScaleTarget = 1;
    _coolDownT = 0.5;     // s — fenêtre de lissage post-end()
    const cb = _onEnd; _onEnd = null;
    if(cb){ try{ cb(); }catch(_){} }
  }

  function update(rawDt){
    // Lissage du ralenti même après end() : descente progressive vers 1.
    if(!active){
      if(_coolDownT > 0){
        _coolDownT = Math.max(0, _coolDownT - rawDt);
        _timeScale += (1 - _timeScale) * Math.min(1, rawDt * 6);
      } else {
        _timeScale = 1;
      }
      return;
    }
    _t += rawDt;
    if(_t >= _dur){ end(); return; }
    // ease-in-out global sur la spline
    const k = Math.min(1, _t / _dur);
    const e = k < 0.5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2)/2;
    _pathCam.getPoint(e, _tmpP);
    _pathTar.getPoint(e, _tmpT);
    if(typeof camera !== 'undefined' && camera){
      // M-Cinéma Lot C : lerp 0.18 (contemplatif) au lieu de 0.30 → entrée
      //   plus douce depuis la position courante de la caméra.
      camera.position.lerp(_tmpP, 0.18);
      camera.lookAt(_tmpT);
      if(_fov != null){
        if(Math.abs(camera.fov - _fov) > 0.05){
          camera.fov += (_fov - camera.fov) * 0.05;
          camera.updateProjectionMatrix();
        }
      }
    }
    // facteur de transition : 0 au début → 1 après fadeIn, redescend dans fadeOut.
    let envel = 1;
    if(_t < _fadeIn) envel = _t / _fadeIn;
    else if(_t > _dur - _fadeOut) envel = Math.max(0, (_dur - _t) / _fadeOut);
    // Time-scale : lissé vers la cible (entrée) et vers 1 (sortie).
    _timeScale += (_timeScaleTarget - _timeScale) * Math.min(1, rawDt * 4);
    // DoF — focus = distance camera → cible (sujet) ; aperture + maxblur montent.
    if(bokehPass && bokehPass.enabled){
      const dist = camera.position.distanceTo(_tmpT);
      bokehPass.uniforms.focus.value    = dist;
      bokehPass.uniforms.aperture.value = _baseAperture + (0.00018 - _baseAperture) * envel;
      bokehPass.uniforms.maxblur.value  = _baseMaxBlur  + (0.030    - _baseMaxBlur ) * envel;
    }
    // Grain renforcé
    if(gradePass) gradePass.uniforms.uGrain.value = _baseGrain * (1 + 1.5 * envel);
  }

  function isActive(){ return active; }
  function getTimeScale(){ return _timeScale; }

  return { begin, skip, end, update, isActive, getTimeScale };
})();
if(typeof window !== 'undefined') window.__cinema = CinemaMode;

/* =====================================================================
   M-Cinéma — SÉQUENCES SCRIPTÉES (déclenchées par la simulation).
   Chacune lit l'état réel pour adapter le focus / la durée. JAMAIS
   d'écriture dans state ; jamais de blocage du joueur (skip permanent).

     • playIntro()  — au lancement : travelling lent sur la ville à
                      l'aube/crépuscule, fin sur le chariot.
     • playCycle()  — à chaque A→A' réussi : panoramique sur la zone
                      qui a le plus changé depuis le dernier cycle.
     • playCrise()  — quand la colère franchit le seuil 0.65 : plan
                      grave, ralenti, sur l'attroupement devant l'usine.
     • playEnd(outcome) — hook commenté pour la condition de fin.
   ===================================================================== */
const CinemaSequences = (function(){
  let _introPlayed = false;
  let _lastColere  = 0;
  let _cycleSnapshot = null;
  let _crisisCooldown = 0;        // s — anti-rejouage trop fréquent
  // marqueurs des dernières valeurs pour détecter les deltas
  function _zonePosSafe(name){
    if(typeof zonePos !== 'function') return new THREE.Vector3();
    const p = zonePos(name); return new THREE.Vector3(p.x, 0, p.z);
  }
  function _snapState(){
    return {
      argent:        state.argent || 0,
      profitCumule:  state.profitCumule || 0,
      travailleurs:  state.travailleurs || 0,
      niveauVille:   state.niveauVille || 0,
      niveauMachine: state.niveauMachine || 0,
      bUsine:        (state.buildings && state.buildings.usine) || 0,
      bQuartier:     (state.buildings && state.buildings.quartier) || 0,
      bBourse:       (state.buildings && state.buildings.bourse) || 0,
      bPort:         (state.buildings && state.buildings.port) || 0,
    };
  }
  function _biggestChange(prev){
    if(!prev) return null;
    const now = _snapState();
    // chaque candidat = { zone, weight }
    const candidates = [
      { zone:'Usine',                weight: (now.niveauMachine - prev.niveauMachine)*1.8 + (now.bUsine - prev.bUsine)*2.0 },
      { zone:'Quartier ouvrier',     weight: (now.bQuartier - prev.bQuartier)*2.0 + Math.max(0, now.travailleurs - prev.travailleurs)*0.30 },
      { zone:'Bourse',               weight: (now.bBourse - prev.bBourse)*2.0 + Math.max(0, (now.argent - prev.argent))/600 },
      { zone:'Port · Marché mondial', weight: (now.bPort - prev.bPort)*2.5 },
    ];
    candidates.sort((a,b)=>b.weight - a.weight);
    return (candidates[0].weight > 0.3) ? candidates[0].zone : null;
  }

  function playIntro(onEnd){
    if(_introPlayed) return false;
    if(typeof CinemaMode==='undefined' || CinemaMode.isActive()) return false;
    _introPlayed = true;
    // Travelling lent en hauteur sur la ville : ouest → est → finit au chariot.
    const vx = (typeof Vehicle!=='undefined' && Vehicle.pos) ? Vehicle.pos.x : -95;
    const vz = (typeof Vehicle!=='undefined' && Vehicle.pos) ? Vehicle.pos.z : 2;
    return CinemaMode.begin({
      camPath: [
        new THREE.Vector3(-90, 36,  60),
        new THREE.Vector3(-30, 42,  10),
        new THREE.Vector3( 40, 38,  -8),
        new THREE.Vector3( 85, 26,  20),
        new THREE.Vector3( vx - 18, 6.0, vz + 14),
        new THREE.Vector3( vx - 8,  3.5, vz + 6),
      ],
      targetPath: [
        new THREE.Vector3(-30, 8,  0),
        new THREE.Vector3(-15, 8, 30),
        new THREE.Vector3(  0, 6, 30),
        new THREE.Vector3(  0, 4, 60),
        new THREE.Vector3( vx, 1.8, vz),
        new THREE.Vector3( vx, 1.6, vz),
      ],
      duration: 11.5,
      title: 'La Veille du Capital',
      timeScale: 0.30,
      fov: 50,
      onEnd: (typeof onEnd==='function') ? onEnd : null,
    });
  }

  // La clôture des communs — l'acte II se regarde. La caméra quitte le chariot
  //   et fait le tour des champs pendant que les paysans les quittent.
  function playEnclosure(onEnd){
    if(typeof CinemaMode==='undefined' || CinemaMode.isActive()) return false;
    const c = _zonePosSafe('Terres communes');
    return CinemaMode.begin({
      camPath: [
        new THREE.Vector3(c.x + 24, 7,  c.z + 26),
        new THREE.Vector3(c.x + 6,  12, c.z + 28),
        new THREE.Vector3(c.x - 11, 9,  c.z + 19),
        new THREE.Vector3(c.x - 13, 5.5, c.z + 5),
      ],
      targetPath: [
        new THREE.Vector3(c.x,     1.5, c.z),
        new THREE.Vector3(c.x,     1.5, c.z - 2),
        new THREE.Vector3(c.x + 2, 1.2, c.z - 2),
        new THREE.Vector3(c.x + 4, 1.0, c.z),
      ],
      duration: 7,
      title: 'Les communs sont clôturés',
      timeScale: 0.30,
      fov: 46,
      onEnd: (typeof onEnd==='function') ? onEnd : null,
    });
  }

  function snapshotCycle(){
    _cycleSnapshot = _snapState();
  }
  function playCycle(){
    if(typeof CinemaMode==='undefined' || CinemaMode.isActive()) return false;
    const zoneName = _biggestChange(_cycleSnapshot);
    _cycleSnapshot = null;
    if(!zoneName) return false;
    const z = _zonePosSafe(zoneName);
    // panoramique 6-8s : approche en orbite puis cadrage haut sur la zone.
    const dur = 6.5 + Math.random()*1.5;
    const titles = {
      'Usine':                'L’usine a grandi',
      'Quartier ouvrier':     'Le quartier s’est densifié',
      'Bourse':               'La Bourse brille plus fort',
      'Port · Marché mondial': 'Le port s’ouvre au monde',
    };
    return CinemaMode.begin({
      camPath: [
        new THREE.Vector3(z.x - 22, 8, z.z + 18),
        new THREE.Vector3(z.x + 4,  16, z.z + 22),
        new THREE.Vector3(z.x + 20, 12, z.z - 4),
        new THREE.Vector3(z.x - 6,  18, z.z - 18),
      ],
      targetPath: [
        new THREE.Vector3(z.x, 4, z.z),
        new THREE.Vector3(z.x, 5, z.z),
        new THREE.Vector3(z.x, 5, z.z),
        new THREE.Vector3(z.x, 6, z.z),
      ],
      duration: dur,
      title: titles[zoneName] || zoneName,
      timeScale: 0.35,
      fov: 46,
    });
  }

  function playCrise(){
    if(typeof CinemaMode==='undefined' || CinemaMode.isActive()) return false;
    if(_crisisCooldown > 0) return false;
    _crisisCooldown = 35;       // anti-rejouage : 35 s mini entre 2 crises
    const z = _zonePosSafe('Usine');
    // Plan grave, ralenti marqué (0.20), focus sur l'attroupement (z+11).
    return CinemaMode.begin({
      camPath: [
        new THREE.Vector3(z.x - 6,  3.5, z.z + 22),
        new THREE.Vector3(z.x + 0,  2.8, z.z + 17),
        new THREE.Vector3(z.x + 4,  3.6, z.z + 14),
      ],
      targetPath: [
        new THREE.Vector3(z.x, 1.6, z.z + 11),
        new THREE.Vector3(z.x, 1.7, z.z + 11),
        new THREE.Vector3(z.x, 1.7, z.z + 11),
      ],
      duration: 5.5,
      title: 'La colère monte',
      timeScale: 0.20,
      fov: 38,
    });
  }

  // playEnd(outcome) — HOOK COMMENTÉ. Pas de condition de fin formalisée
  //   aujourd'hui dans la sim ; cf. state.d.declenche pour la crise et
  //   state.cyclesProfitables pour l'accumulation. À brancher quand la
  //   condition de victoire/effondrement existera dans le moteur.
  /*
  function playEnd(outcome){
    const isWin = outcome === 'accumulation';
    const z = _zonePosSafe(isWin ? 'Bourse' : 'Quartier ouvrier');
    return CinemaMode.begin({
      camPath: [...], targetPath: [...],
      duration: 9, timeScale: 0.18, fov: 42,
      title: isWin ? 'L’accumulation triomphante' : 'L’effondrement',
    });
  }
  */

  // Hook frame-by-frame :
  //   • intro : déclenchée DÉTERMINISTE au handoff (cf. startGame), plus de
  //     timer fragile ici — _introPlayed garde l'unicité par chargement ;
  //   • détection de franchissement de seuil colère (0.65 = 'colere2').
  function tick(dt){
    if(_crisisCooldown > 0) _crisisCooldown = Math.max(0, _crisisCooldown - dt);
    if(typeof state === 'undefined' || !state) return;
    const c = state.colere || 0;
    const SEUIL = 0.65;
    if(_lastColere < SEUIL && c >= SEUIL){
      // Évite de cinématiser pendant une modale ouverte.
      if(!(typeof anyModalOpen==='function' && anyModalOpen())) playCrise();
    }
    _lastColere = c;
  }

  function debug(){ return { introPlayed:_introPlayed, crisisCooldown:+_crisisCooldown.toFixed(1) }; }

  /* M9 — cet état vivait dans la closure, donc hors de portée de la
     sauvegarde : une séquence déjà vue se rejouait après reprise.
     `_lastColere` est le plus important des quatre — c'est la mémoire de
     détection de FRANCHISSEMENT du seuil. Sans lui, reprendre une partie
     dont la colère est déjà au-dessus de 0.65 repart de 0 et déclenche
     aussitôt la cinématique de crise, alors qu'aucun seuil n'a été
     franchi. Donnée pure : nombres, booléen, objet plat. */
  function etat(){
    return { introPlayed:_introPlayed, lastColere:_lastColere,
             crisisCooldown:_crisisCooldown, cycleSnapshot:_cycleSnapshot };
  }
  function restaurer(o){
    if(!o) return;
    if(typeof o.introPlayed==='boolean')   _introPlayed    = o.introPlayed;
    if(typeof o.lastColere==='number')     _lastColere     = o.lastColere;
    if(typeof o.crisisCooldown==='number') _crisisCooldown = o.crisisCooldown;
    _cycleSnapshot = o.cycleSnapshot || null;
  }

  return { playIntro, playEnclosure, playCycle, playCrise, snapshotCycle, tick, debug, etat, restaurer };
})();
if(typeof window !== 'undefined') window.__sequences = CinemaSequences;

/* M-POV — INDICATEUR DE BORD D'ÉCRAN pour l'objectif.
   Visible uniquement en mode 'shoulder' ou 'immersion' (la vue Carte
   garde la balise visible naturellement). Apparaît si la cible est
   hors champ de la caméra. Pointe DOM (CSS) — pas de fragment shader,
   compatible avec le HUD existant. */
let _M_POV_indicatorEl=null, _M_POV_indicatorTri=null;
function _M_POV_ensureIndicator(){
  if(_M_POV_indicatorEl) return;
  const wrap=document.createElement('div');
  wrap.id='pov-target-indicator';
  wrap.style.cssText='position:fixed;left:0;top:0;width:42px;height:42px;'
    +'pointer-events:none;z-index:60;transform:translate(-50%,-50%) rotate(0deg);'
    +'display:none;will-change:transform,left,top;';
  const tri=document.createElement('div');
  // Triangle rouge papier avec léger halo.
  tri.style.cssText='width:0;height:0;'
    +'border-left:14px solid transparent;border-right:14px solid transparent;'
    +'border-bottom:24px solid #b94a3a;'
    +'filter:drop-shadow(0 0 6px rgba(185,74,58,0.65));'
    +'margin:0 auto;';
  wrap.appendChild(tri);
  document.body.appendChild(wrap);
  _M_POV_indicatorEl=wrap; _M_POV_indicatorTri=tri;
}
const _M_POV_tmpVec=new THREE.Vector3();
function _M_POV_updateTargetIndicator(){
  if(CAM_MODE === 'map'){
    if(_M_POV_indicatorEl) _M_POV_indicatorEl.style.display='none';
    return;
  }
  if(typeof targetMarker==='undefined' || !targetMarker || !targetMarker.visible){
    if(_M_POV_indicatorEl) _M_POV_indicatorEl.style.display='none';
    return;
  }
  _M_POV_ensureIndicator();
  // Projette la position monde de la cible (un peu en l'air pour viser
  // au-dessus du sol) en coordonnées NDC.
  _M_POV_tmpVec.set(targetMarker.position.x, 6, targetMarker.position.z);
  _M_POV_tmpVec.project(camera);
  // Si NDC dans [-0.92, 0.92] X et Y, ET z<1 (devant), la cible est à
  // l'écran : on cache l'indicateur.
  const onScreen = _M_POV_tmpVec.z < 1
                && Math.abs(_M_POV_tmpVec.x) < 0.92
                && Math.abs(_M_POV_tmpVec.y) < 0.92;
  if(onScreen){
    _M_POV_indicatorEl.style.display='none';
    return;
  }
  // Sinon : positionne l'indicateur sur le bord d'écran, dans la
  // direction de la projection (clamp aux bords).
  // Si la cible est DERRIÈRE la caméra (z >= 1), on inverse le vecteur.
  let nx=_M_POV_tmpVec.x, ny=_M_POV_tmpVec.y;
  if(_M_POV_tmpVec.z >= 1){ nx=-nx; ny=-ny; }
  // Clamp au cercle inscrit dans le rectangle de l'écran (marge 28px).
  const W=innerWidth, H=innerHeight;
  const margin=32;
  const cx=W/2, cy=H/2;
  const hx=W/2 - margin, hy=H/2 - margin;
  // Inverse Y NDC car écran +Y bas.
  const vx=nx, vy=-ny;
  const len=Math.hypot(vx, vy) || 1;
  const ux=vx/len, uy=vy/len;
  // Trouve t tel qu'on touche le bord (rectangle [hx,hy]).
  const tX=hx/Math.max(1e-3, Math.abs(ux));
  const tY=hy/Math.max(1e-3, Math.abs(uy));
  const t=Math.min(tX, tY);
  const px=cx + ux*t, py=cy + uy*t;
  // Rotation du triangle : pointe dans la direction (vx,vy).
  const ang=Math.atan2(vy, vx) + Math.PI/2;
  _M_POV_indicatorEl.style.display='block';
  _M_POV_indicatorEl.style.left=px+'px';
  _M_POV_indicatorEl.style.top=py+'px';
  _M_POV_indicatorEl.style.transform='translate(-50%,-50%) rotate('+ang.toFixed(3)+'rad)';
}

/* ===================================================================
   Input  —  clavier (flèches + ZQSD/WASD)
   =================================================================== */
/* v67 — LE TACTILE. Vrai quand le pointeur principal est grossier (un doigt),
   avec le repli des vieux WebKit qui ne connaissent pas la media query. */
const TOUCH=(window.matchMedia&&matchMedia('(pointer:coarse)').matches)
  ||(navigator.maxTouchPoints>0&&/Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
const Input={fwd:false,back:false,left:false,right:false};
const KEYMAP={
  ArrowUp:'fwd', KeyW:'fwd', KeyZ:'fwd',
  ArrowDown:'back', KeyS:'back',
  ArrowLeft:'left', KeyA:'left', KeyQ:'left',
  ArrowRight:'right', KeyD:'right',
};

/* v67 — Commandes tactiles : le levier écrit les quatre mêmes booléens que
   le clavier, les boutons appellent les mêmes fonctions que les touches.
   Rien d'autre du jeu ne sait qu'on est au doigt. */
function installTouchControls(){
  const tc=document.getElementById('tc'); if(!tc) return;
  document.documentElement.classList.add('tactile');
  const stick=document.getElementById('tc-stick'), knob=stick.querySelector('.tc-knob');
  let pid=null, cx=0, cy=0, R=64;
  function setDir(dx,dy){
    const r=Math.hypot(dx,dy), dead=R*0.22;
    const k=Math.min(1,r/R), ux=r?dx/r:0, uy=r?dy/r:0;
    knob.style.transform=`translate(${ux*k*R*0.55}px,${uy*k*R*0.55}px)`;
    if(r<dead){ Input.fwd=Input.back=Input.left=Input.right=false; return; }
    /* avant/arrière quand le levier est franchement vertical ; le braquage
       prend dès qu'on s'écarte de l'axe */
    Input.fwd = -dy>dead && -dy>Math.abs(dx)*0.45;
    Input.back = dy>dead && dy>Math.abs(dx)*0.45;
    Input.left = -dx>dead;
    Input.right = dx>dead;
    stick.dataset.dir=['fwd','back','left','right'].filter(k=>Input[k]).join(' ');
  }
  const end=e=>{ if(e&&e.pointerId!==pid) return; pid=null; stick.classList.remove('on'); knob.style.transform='';
    Input.fwd=Input.back=Input.left=Input.right=false; stick.dataset.dir=''; };
  stick.addEventListener('pointerdown',e=>{ if(pid!==null) return; pid=e.pointerId;
    try{ stick.setPointerCapture(pid); }catch(_){}
    const b=stick.getBoundingClientRect(); cx=b.left+b.width/2; cy=b.top+b.height/2; R=b.width/2;
    stick.classList.add('on'); setDir(e.clientX-cx,e.clientY-cy); e.preventDefault(); });
  stick.addEventListener('pointermove',e=>{ if(e.pointerId!==pid) return; setDir(e.clientX-cx,e.clientY-cy); e.preventDefault(); });
  stick.addEventListener('pointerup',end); stick.addEventListener('pointercancel',end);
  stick.addEventListener('lostpointercapture',end);
  const agir=document.getElementById('tc-agir'), voile=document.getElementById('tc-voile'), cam=document.getElementById('tc-cam');
  agir.addEventListener('click',()=>{ if(currentZone) interactZone(currentZone); });
  voile.addEventListener('click',()=>{ if(voileUnlocked) toggleMarx(); });
  cam.addEventListener('click',()=>{ CameraController.cycleMode(); });
  /* l'invite de zone, au-dessus des commandes, se touche aussi */
  const pr=document.getElementById('prompt');
  if(pr) pr.addEventListener('click',()=>{ if(currentZone) interactZone(currentZone); });
  setInterval(()=>{
    agir.classList.toggle('on', !!currentZone);
    voile.hidden=!voileUnlocked;
    voile.classList.toggle('on', !!marxView);
  },250);
  /* la barre du circuit défile sur petit écran : la case courante reste au champ */
  let lastNow=null;
  setInterval(()=>{ const n=document.querySelector('.circuit .now');
    if(n&&n!==lastNow){ lastNow=n; try{ n.scrollIntoView({inline:'center',block:'nearest'}); }catch(_){} } },600);
}
/* Le jeu nomme ses touches dans des dizaines de textes (« Appuie sur E »,
   « Z Q S D », « Touche V »). Au doigt, ces mots sont faux. Plutôt que de
   retoucher chaque chaîne, on corrige ce qui ARRIVE À L'ÉCRAN : un observateur
   réécrit les <b>E</b> et leurs verbes. Idempotent — une seconde passe ne
   trouve plus rien à changer. */
function installTouchText(){
  function fixText(n){
    const v=n.nodeValue; if(!v) return;
    let w=v.replace(/Touche V — /g,'Bouton Voile — ');
    if(w!==v) n.nodeValue=w;
  }
  function fix(root){
    if(!root||root.nodeType!==1) return;
    const bs=root.matches&&root.matches('b')?[root]:[]; root.querySelectorAll('b').forEach(b=>bs.push(b));
    for(const b of bs){
      const t=b.textContent;
      if(t==='E'){
        b.textContent='Agir';
        const p=b.previousSibling;
        if(p&&p.nodeType===3){ p.nodeValue=p.nodeValue.replace(/Appuie sur $/,'Touche ').replace(/appuie sur $/,'touche ')
          .replace(/appuies sur $/,'touches ').replace(/\(touche $/,'(bouton '); }
      } else if(t==='Z Q S D'){ b.textContent='le levier, en bas à gauche,'; }
      else if(/^Appuie sur E pour /.test(t)){ b.textContent=t.replace('Appuie sur E pour','Touche Agir pour'); }
    }
    const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())) fixText(n);
  }
  new MutationObserver(ms=>{ for(const m of ms) m.addedNodes.forEach(n=>fix(n.nodeType===1?n:n.parentElement)); })
    .observe(document.body,{childList:true,subtree:true});
  fix(document.body);
}
if(TOUCH){ installTouchControls(); installTouchText(); }
addEventListener('keydown',e=>{ const k=KEYMAP[e.code]; if(k){Input[k]=true;e.preventDefault();}
  if(e.code==='KeyR'){Vehicle.reset();}
  if(e.code==='KeyC'){ e.preventDefault(); CameraController.cycleMode(); }
  if(e.code==='KeyV'){ if(voileUnlocked) toggleMarx(); }
  if(e.code==='KeyL'){ VISUAL_LIFE=!VISUAL_LIFE; pushLog('Affichage','Vie visuelle : '+(VISUAL_LIFE?'complète':'réduite (performance)')+'.','plain'); }
  if(e.code==='KeyK'){ GRAPHICS_QUALITY=(GRAPHICS_QUALITY==='low'?'medium':GRAPHICS_QUALITY==='medium'?'high':'low');
    pushLog('Affichage','Qualité graphique : '+GRAPHICS_QUALITY+'.','plain'); }
  if(e.code==='KeyJ'){ DETAIL_LEVEL=(DETAIL_LEVEL==='low'?'medium':DETAIL_LEVEL==='medium'?'high':'low');
    pushLog('Affichage','Densité du décor : '+DETAIL_LEVEL+' (recharge la page pour l’appliquer pleinement).','plain'); }
  if(e.code==='KeyH'){ toggleSettingsPanel(); }
  if(e.code==='KeyB'){ AmbientSound.start(); AmbientSound.toggle(); }
  if(e.code==='KeyE'){ e.preventDefault(); if(currentZone) interactZone(currentZone); }
  if(e.code==='Backquote'){ e.preventDefault(); setQA(!QA_MODE); }
  // M-Cinéma — déclencheur de test (KeyN) : lance une courte séquence de
  //   travelling contemplatif autour de la ville, point de focus = chariot.
  if(e.code==='KeyN' && typeof CinemaMode !== 'undefined' && !CinemaMode.isActive()){
    e.preventDefault();
    const vx = Vehicle.pos.x, vz = Vehicle.pos.z;
    CinemaMode.begin({
      camPath: [
        new THREE.Vector3(vx - 28, 4.5, vz + 22),
        new THREE.Vector3(vx - 10, 9.0, vz + 16),
        new THREE.Vector3(vx + 12, 11.0, vz +  8),
        new THREE.Vector3(vx + 26, 8.0, vz -  6),
      ],
      targetPath: [
        new THREE.Vector3(vx, 1.6, vz),
        new THREE.Vector3(vx, 1.8, vz),
        new THREE.Vector3(vx, 2.0, vz),
        new THREE.Vector3(vx, 1.8, vz),
      ],
      duration: 6.5,
      title: 'La Veille du Capital',
      timeScale: 0.30,
      fov: 48,
    });
    pushLog('Cinéma', 'Séquence de test — ESC ou clic pour passer.', 'plain');
  }
  // M7-soleil — accélération du temps : ',' ralentit, '.' accélère, '/' = 1.0,
  // ';' (Semicolon) pour avancer instantanément +5% du cycle (rapide pour tester).
  if(e.code==='Comma'){ TIME_SPEED = Math.max(0.5, TIME_SPEED * 0.5); pushLog('Cycle','×'+TIME_SPEED.toFixed(2)+' temps.','plain'); }
  if(e.code==='Period'){ TIME_SPEED = Math.min(64, TIME_SPEED * 2.0); pushLog('Cycle','×'+TIME_SPEED.toFixed(2)+' temps.','plain'); }
  if(e.code==='Slash'){ TIME_SPEED = 1.0; pushLog('Cycle','×1 temps.','plain'); }
  if(e.code==='Semicolon'){ timeOfDay = (timeOfDay + 0.05) % 1; pushLog('Cycle','heure '+(timeOfDay*24).toFixed(1)+'h.','plain'); }
  // M1b — F3 : toggle du panneau #qa (fps / calls / triangles). Même état
  // que Backquote (legacy) ; l'état persiste pendant la session.
  if(e.code==='F3'){ e.preventDefault(); setQA(!QA_MODE); }
});
addEventListener('keyup',  e=>{ const k=KEYMAP[e.code]; if(k){Input[k]=false;e.preventDefault();} });
function toggleSettingsPanel(force){
  const h=document.getElementById('help'); if(!h) return;
  h.classList.toggle('open', force===undefined ? !h.classList.contains('open') : !!force);
}
const settingsToggle=document.getElementById('settings-toggle');
if(settingsToggle){
  settingsToggle.setAttribute('type','button');
  settingsToggle.addEventListener('pointerdown',e=>{ e.stopPropagation(); });
  settingsToggle.addEventListener('click',e=>{ e.preventDefault(); e.stopPropagation(); toggleSettingsPanel(); });
}
// M1 — sélecteur Rendu (Basse/Moyenne/Haute), à chaud, dans le panneau réglages.
(function bindRenderQualitySelector(){
  const seg=document.getElementById('rq-seg'); if(!seg) return;
  seg.addEventListener('click', e=>{
    const btn=e.target.closest('.rq'); if(!btn) return;
    const q=btn.dataset.q; if(!q || q===RENDER_QUALITY) return;
    seg.querySelectorAll('.rq').forEach(b=>b.classList.toggle('active', b===btn));
    applyRenderQuality(q);
    pushLog('Affichage','Rendu : '+({low:'Basse',medium:'Moyenne',high:'Haute'}[q])+'.','plain');
  });
})();

/* ===================================================================
   HUD + interaction de zone
   =================================================================== */
function fmtMoney(x){return Math.round(x).toLocaleString('fr-FR')+' £';}
/* v47 — HUD hiérarchisé : 7 variables structurantes toujours visibles.
   Chaque ligne montre la valeur (colorée selon un seuil ok/ambre/rouge)
   et le delta du dernier cycle (▲/▼). Le joueur lit l'état du système
   d'un coup d'œil, sans ouvrir de panneau. */
const HUDTrack={prev:null};
function hudDelta(id,val,inverse){ // inverse=true : une hausse est "mauvaise" (dette, stocks, chômage…)
  const el=document.getElementById(id); if(!el) return;
  if(!HUDTrack.prev){ el.textContent=''; return; }
  const pv=HUDTrack.prev[id];
  if(pv==null||!isFinite(pv)){ el.textContent=''; return; }
  const dv=val-pv;
  if(Math.abs(dv)<0.004){ el.textContent=''; el.className='delta'; return; }
  const good=inverse? dv<0 : dv>0;
  el.className='delta '+(good?'up':'dn');
  el.textContent=(dv>0?'▲':'▼');
}
function hudLevel(id,ratio){ // ratio 0..1 : <0.5 ok, <0.75 ambre, sinon rouge
  const el=document.getElementById(id); if(!el) return;
  el.classList.remove('warnv','dangerv');
  if(ratio>=0.75) el.classList.add('dangerv');
  else if(ratio>=0.5) el.classList.add('warnv');
}
function updateHUD(){
  const m=MiniCircuit;
  const o=objectifCourant();
  const hudTitle=document.getElementById('hud-title'), argLab=document.getElementById('h-argent-lab');
  if(gamePhase==='precapital'){
    // Fondation : un seul chiffre — et le libellé dit que ce n'est pas encore du capital.
    if(hudTitle && !marxView) hudTitle.textContent='Ton coffre';
    if(argLab) argLab.textContent='Argent';
    set('h-argent',fmtMoney(m.argent));
    set('h-obj','créer les conditions');
    ['h-dette','h-profit','h-stocks','h-chomage','h-colere','h-risque'].forEach(id=>set(id,'—'));
    ['d-argent','d-dette','d-profit','d-stocks','d-chomage','d-colere','d-risque'].forEach(id=>{const e=document.getElementById(id); if(e) e.textContent='';});
    return;
  }
  const d=state.d||{};
  if(hudTitle && !marxView) hudTitle.textContent='Tableau de bord';
  if(argLab) argLab.textContent='Capital';
  const profit=Math.round(d.resultatNet!=null?d.resultatNet:(d.profitRealise||0));
  const vals={ 'd-argent':state.argent, 'd-dette':state.dette, 'd-profit':profit,
    'd-stocks':state.stocks, 'd-chomage':state.chomage, 'd-colere':state.colere,
    'd-risque':(d.risqueCrise||0) };
  set('h-argent',fmtMoney(m.argent));
  set('h-dette',fmtMoney(state.dette||0));
  set('h-profit',(profit>=0?'+':'−')+fmtMoney(Math.abs(profit)));
  set('h-stocks',Math.round(state.stocks)+' u.');
  set('h-chomage',Math.round(state.chomage*100)+' %');
  set('h-colere',Math.round(m.colere*100)+' %');
  set('h-risque',Math.round((d.risqueCrise||0)*100)+' %');
  set('h-obj',o.court||'—');
  // deltas (▲▼) par rapport au dernier rafraîchissement de cycle
  hudDelta('d-argent',vals['d-argent'],false);
  hudDelta('d-dette',vals['d-dette'],true);
  hudDelta('d-profit',vals['d-profit'],false);
  hudDelta('d-stocks',vals['d-stocks'],true);
  hudDelta('d-chomage',vals['d-chomage'],true);
  hudDelta('d-colere',vals['d-colere'],true);
  hudDelta('d-risque',vals['d-risque'],true);
  // couleurs de seuil : la jauge dit où le système se tend
  const pf=document.getElementById('h-profit');
  if(pf){ pf.classList.remove('warnv','dangerv'); if(profit<0) pf.classList.add('dangerv'); }
  hudLevel('h-dette', state.dette/Math.max(1,state.plafondCredit||600));
  hudLevel('h-stocks', state.stocks/(STOCK_SEUIL+(state.stockCapaciteBonus||0)));
  hudLevel('h-chomage', state.chomage/0.5);
  hudLevel('h-colere', state.colere/0.8);
  hudLevel('h-risque', (d.risqueCrise||0)/0.8);
  HUDTrack.lastVals=vals;
}
/* mémorise les valeurs APRÈS chaque cycle : les deltas comparent cycle à cycle, pas image à image */
function snapshotHUD(){ HUDTrack.prev=Object.assign({},HUDTrack.lastVals||null); }
function set(id,v){document.getElementById(id).textContent=v;}

let marxView=false;
function toggleMarx(){ marxView=!marxView;
  document.getElementById('marxbox').style.display=marxView?'block':'none';
  document.getElementById('hud-title').textContent=marxView?'Sous le voile':'Tableau de bord';
}
function updateMarx(){
  const d=state.d, g=id=>document.getElementById(id); if(!g('m-pv'))return;
  g('m-pv').textContent=money(d.plusValue||0);
  g('m-tx').textContent=pct(d.tauxExploitation||0);
  g('m-c').textContent=money(d.c||0);
  g('m-v').textContent=money(d.v||0);
  g('m-tp').textContent=pct(d.tauxProfit||0);
  g('m-co').textContent=(d.compoOrganique||0).toFixed(2);
  g('m-part').textContent=pct(d.partJoueur||0);
  g('m-stocks').textContent=Math.round(state.stocks)+' u.';
}
function renderLeviers(){
  const g=id=>document.getElementById(id); if(!g('vh'))return;
  const stage=productionPlaceLabel();
  if(g('lev-title')) g('lev-title').textContent='État de l’usine';
  if(g('lev-place')) g('lev-place').textContent='Usine';
  if(g('lev-stage')) g('lev-stage').textContent=stage;
  g('vh').textContent=state.heures+' h'+(state.limiteJournee<18?` (max ${state.limiteJournee})`:'');
  g('vs').textContent=state.salaire+' £';
  g('vl').textContent=state.travailleurs;
  g('vm').textContent='niv. '+state.niveauMachine;
}
/* ===================================================================
   MISSION  —  le circuit guidé A → M → Ft → P → M′ → A′
   Le joueur boucle le trajet dans l'ordre ; arriver à A′ réalise le cycle.
   =================================================================== */
const CIRCUIT = [
  {zone:'Banque',             sym:'A',   key:'A',   full:'Argent',                tip:'A = argent avancé'},
  {zone:'Marché des moyens',  sym:'M',   key:'M',   full:'Machines et matières',  tip:'M = moyens de production'},
  {zone:'Marché du travail',  sym:'Ft',  key:'Ft',  full:'Force de travail',      tip:'Ft = force de travail'},
  {zone:'Usine',              sym:'P',   key:'P',   full:'Production',             tip:'P = production'},
  {zone:'Entrepôt',           sym:'M′',  key:'M′',  full:'Marchandises',          tip:'M′ = marchandises produites'},
  {zone:'Marché de vente',    sym:'A′',  key:"A'",  full:'Argent augmenté',       tip:'A′ = argent revenu augmenté'},
];

// Vocabulaire visible : le bâtiment reste toujours l'Usine sur la carte.
// Le stade historique du procès de production est indiqué séparément :
// Atelier → Manufacture → Grande industrie.
function productionPlaceLabel(s=state){
  const age=(s&&s.age)||1;
  if(age>=3) return 'Usine';
  if(age>=2) return 'Manufacture';
  return 'Atelier';
}
function displayZoneName(name){ return name; }
function displayZoneShort(name){ return displayZoneName(name).replace('Marché','M.'); }
function productionPlaceInfo(){
  const p=productionPlaceLabel();
  if(p==='Atelier') return 'Usine — bâtiment de production (P). Stade actuel : atelier, avec quelques ouvriers, des outils et une discipline encore fragile.';
  if(p==='Manufacture') return 'Usine — bâtiment de production (P). Stade actuel : manufacture, avec division du travail, surveillance et fatigue collective.';
  return 'Usine — bâtiment de production (P). Stade actuel : grande industrie, avec machines, productivité massive, chômage et surproduction possibles.';
}
function zoneInfo(name){
  const cf=(typeof CompetitorWorld!=='undefined')&&CompetitorWorld.byZone?CompetitorWorld.byZone(name):null;  // v48
  if(cf) return CompetitorWorld.promptInfo(cf);
  return name==='Usine' ? productionPlaceInfo() : (ZONE_INFO[name]||'');
}
function displayCircuitStep(c){ return displayZoneShort(c.zone); }
let step = 0;                 // index du PROCHAIN lieu requis
let voileUnlocked = false;
let gameOver = false;
let gamePhase = 'precapital';  // 'precapital' (argent dormant) puis 'circuit'
/* LA FONDATION DU CAPITAL — trois actes, deux gestes chacun.
   C'est la source unique du plan : la barre du haut, le carnet (coach) et le
   plan du chantier la lisent. Acte I : l'argent se fixe dans des moyens de
   production. Acte II : l'autre côté du marché — la clôture des communs
   fabrique des vendeurs de force de travail, on embauche. Acte III : la
   rencontre — on produit, on vend, et l'on compte. */
const FONDATION = [
  {acte:'I',   nom:'Les moyens de production', steps:[
    {id:'atelier',   sym:'At', nm:'L’atelier',      done:()=>state.buildings.atelier>0},
    {id:'outils',    sym:'Ou', nm:'Les outils',     done:()=>state.buildings.outils>0}]},
  {acte:'II',  nom:'L’autre côté du marché', steps:[
    {id:'enclosure', sym:'Tc', nm:'La clôture',     done:()=>state.buildings.travail>0},
    {id:'embauche0', sym:'Ft', nm:'L’embauche',     done:()=>state.travailleurs>0}]},
  {acte:'III', nom:'La rencontre', steps:[
    {id:'produire',  sym:'M′', nm:'La marchandise', done:()=>!!state.firstProduced},
    {id:'vendre',    sym:'A′', nm:'La vente',       done:()=>!!state.firstSold}]},
];
const PRECAPITAL_STEPS = FONDATION.flatMap(a=>a.steps);
function fondationActe(){ return FONDATION.find(a=>a.steps.some(s=>!s.done())) || FONDATION[FONDATION.length-1]; }
let crisisStreak = 0;         // cycles consécutifs à très haut risque

// Progression pédagogique : un concept par cycle (cf. cahier des charges)
// Objectif de la phase 0 (hors circuit)
const OBJ_PRECAPITAL = {titre:'La fondation', concept:'argent vs capital',
   but:'Faire de ton argent du capital : réunir les moyens de production et la force de travail, produire, vendre.',
   court:'Créer les conditions', rew:'+ le capital prend vie', risk:'rien ne se produit tant que les deux côtés du marché ne sont pas réunis',
   ok:s=>true,
   lecture:'L’argent n’est pas du capital : il ne le devient qu’en se jetant dans le circuit pour en revenir augmenté.'};
// Cycles du circuit — progression PÉDAGOGIQUE par objectifs atteignables (objectifIndex)
// Chaque objectif : ok(s) condition · gauge(s) progression lisible · manque(s) ce qu'il reste
const OBJECTIFS = [
  {titre:'Premier profit', concept:'plus-value',
   but:'Réalise un premier cycle profitable.',
   court:'Profit productif > 0', rew:'+ l’accumulation démarre', risk:'coûts avancés à couvrir',
   ok:s=>(s.d.resultatProductif||0)>0,
   gauge:s=>`Résultat productif : ${money(s.d.resultatProductif||0)} / > 0`,
   manque:s=>`Il manque ${money(Math.max(1,1-(s.d.resultatProductif||0)))} pour un atelier rentable.`,
   lecture:'Le supplément A′ − A vient de la plus-value produite par la force de travail.'},
  {titre:'Accumulation simple', concept:'A → A′',
   but:'Fais revenir l’argent augmenté de manière visible (≥ 20 £ de résultat net).',
   court:'Résultat net ≥ 20 £', rew:'+ trésorerie qui grossit', risk:'intérêts et impôts grignotent le net',
   ok:s=>(s.d.resultatNet||0)>=20,
   gauge:s=>`Résultat net : ${money(s.d.resultatNet||0)} / 20 £`,
   manque:s=>`Il manque ${money(Math.max(1,20-(s.d.resultatNet||0)))} de résultat net.`,
   lecture:'Le capital n’a de sens que s’il revient augmenté : A′ doit dépasser A.'},
  {titre:'Stabiliser l’atelier', concept:'reproduction',
   but:'Enchaîne deux cycles profitables au total.',
   court:'2 cycles profitables', rew:'+ atelier viable', risk:'un cycle déficitaire ne compte pas',
   ok:s=>s.cyclesProfitables>=2,
   gauge:s=>`Cycles profitables : ${s.cyclesProfitables} / 2`,
   manque:s=>`Il manque ${Math.max(1,2-s.cyclesProfitables)} cycle profitable.`,
   lecture:'Un capital ne vit pas d’un coup isolé : il doit reproduire son profit cycle après cycle.'},
  {titre:'Embaucher', concept:'coopération',
   but:'Élargis l’atelier en employant au moins 3 ouvriers.',
   court:'Ouvriers ≥ 3', rew:'+ capacité de production', risk:'+ salaires avancés',
   ok:s=>s.travailleurs>=3,
   gauge:s=>`Ouvriers : ${s.travailleurs} / 3`,
   manque:s=>`Il manque ${Math.max(1,3-s.travailleurs)} ouvrier à embaucher (marché du travail).`,
   lecture:'Réunir plusieurs ouvriers, c’est déjà créer une force productive collective que le capital s’approprie.'},
  {titre:'Manufacture', concept:'division du travail',
   but:'Transforme l’atelier en manufacture : 5 ouvriers et 250 £ de trésorerie.',
   court:'5 ouvriers · 250 £', rew:'+ productivité collective', risk:'+ surveillance, + fatigue',
   ok:s=>s.travailleurs>=5 && s.buildings.atelier>=1 && s.argent>=250,
   gauge:s=>`Ouvriers : ${s.travailleurs} / 5 · Trésorerie : ${money(s.argent)} / 250 £`,
   manque:s=>{const m=[]; if(s.travailleurs<5)m.push(`${5-s.travailleurs} ouvrier(s)`); if(s.argent<250)m.push(`${money(250-s.argent)} de trésorerie`); return 'Il manque : '+(m.join(' et ')||'rien')+'.';},
   lecture:'En répartissant les tâches, le capital augmente la productivité collective sans payer davantage chaque ouvrier.'},
  {titre:'Résister à la concurrence', concept:'contrainte concurrentielle',
   but:'Reste compétitif : garde une part de marché ≥ 25 %.',
   court:'Part ≥ 25 %', rew:'+ tu tiens tes débouchés', risk:'les concurrents baissent les prix',
   ok:s=>(s.d.partJoueur||0)>=0.25,
   gauge:s=>`Part de marché : ${pct(s.d.partJoueur||0)} / 25 %`,
   manque:s=>`Ta part de marché est trop faible : ${pct(s.d.partJoueur||0)} / 25 %. Baisse ton prix ou mécanise.`,
   lecture:'La concurrence force chaque capital à accumuler ou disparaître.'},
  {titre:'Mécanisation', concept:'plus-value relative / machinisme',
   but:'Introduis la machine : atteins le niveau de machine ≥ 2.',
   court:'Machine niv. ≥ 2', rew:'+ productivité', risk:'+ dette, + chômage',
   ok:s=>s.niveauMachine>=2,
   gauge:s=>`Machine : niveau ${s.niveauMachine} / 2`,
   manque:s=>`Il faut acheter une machine (carte « Acheter une machine à crédit » au lieu de production).`,
   lecture:'La machine augmente la productivité, mais alourdit le capital constant et libère des bras.'},
  {titre:'Gérer la dette', concept:'capital financier',
   but:'Empêche le crédit de manger le profit : ramène la dette sous 150 £.',
   court:'Dette < 150 £', rew:'+ profit net préservé', risk:'intérêts si tu laisses filer',
   ok:s=>s.dette<150 || ((s.d.interets||0) < (s.d.resultatProductif||0)),
   gauge:s=>`Dette : ${money(s.dette)} / < 150 £ · Intérêts ${money(s.d.interets||0)} vs atelier ${money(s.d.resultatProductif||0)}`,
   manque:s=>`Ta dette reste trop élevée : ${money(s.dette)} / 150 £ maximum. Rembourse à la banque.`,
   lecture:'Le capital financier prélève sa part : la dette doit rester soutenable pour que l’atelier profite.'},
  {titre:'Gérer le conflit social', concept:'lutte des classes',
   but:'Maintiens le circuit malgré la tension sociale.',
   court:'Colère < 70 % · pas de grève', rew:'+ continuité de la production', risk:'grève, répression, concession',
   ok:s=>s.argent>0 && !s.enGreve && (s.colere<0.70 || s.d.concession || s.d.repression),
   gauge:s=>`Colère : ${pct(s.colere)} / < 70 % · Grève : ${s.enGreve?'oui':'non'}`,
   manque:s=>(s.enGreve?'Une grève bloque le circuit : tranche le conflit (céder, réprimer ou attendre).':`Apaise la tension : colère ${pct(s.colere)} / < 70 % (salaires, journée, sécurité).`),
   lecture:'Le capital ne doit pas seulement vendre ses marchandises : il doit aussi maintenir la force de travail dans le procès de production.'},
  {titre:'Surproduction', concept:'réalisation / surproduction',
   but:'Produis à grande échelle sans saturer le marché.',
   court:'Production ≥ 60 · Stocks < 80', rew:'+ valeur réalisée à grande échelle', risk:'mévente, baisse des prix',
   ok:s=>(s.d.Q||0)>=60 && s.stocks<80,
   gauge:s=>`Production : ${Math.round(s.d.Q||0)} / 60 · Stocks : ${Math.round(s.stocks)} / < 80`,
   manque:s=>((s.d.Q||0)<60 ? 'Tu ne produis pas encore à une échelle suffisante.' : 'Tu produis plus que tu ne réalises par la vente.'),
   lecture:'La valeur produite doit être réalisée par la vente : invendue, elle s’accumule en stock.'},
  {titre:'Première crise', concept:'crise de surproduction',
   but:'Survis à une première tension de crise.',
   court:'Tenir pendant la tension', rew:'+ tu encaisses le choc', risk:'krach, faillite',
   ok:s=>(s.d.risqueCrise||0)>0.35 && s.argent>0,
   gauge:s=>`Risque de crise : ${pct(s.d.risqueCrise||0)} · Solvabilité : ${money(s.argent)}`,
   manque:s=>((s.d.risqueCrise||0)<=0.35 ? 'La crise n’est pas encore ouverte. Continue d’accumuler : les contradictions monteront avec l’échelle.' : 'Reste solvable pendant la tension.'),
   lecture:'La crise n’est pas extérieure au système ; elle émerge de ses propres contradictions.'},
];
// Aides ciblées affichées quand le joueur reste bloqué sur un objectif (parallèle à OBJECTIFS)
const OBJ_HINTS = [
  'Va au lieu de production (P) régler la journée et le salaire pour dégager un profit.',
  'Augmente le profit net : allonge la journée, embauche ou monte le prix — et limite la dette.',
  'Enchaîne des cycles sans déficit : garde des coûts inférieurs à la recette.',
  'Va au marché du travail pour embaucher (vise 3 ouvriers).',
  'Embauche jusqu’à 5 ouvriers et garde 250 £ de trésorerie.',
  'Baisse ton prix ou mécanise pour reprendre des parts de marché.',
  'Va au lieu de production (P) et joue la carte « Acheter une machine à crédit ».',
  'Va à la banque pour rembourser et ramener la dette sous 150 £.',
  'Apaise le conflit : ajuste salaires/journée, améliore la sécurité, ou tranche la grève au panneau.',
  'Va au lieu de production (P) pour produire davantage (embauche, journée, machine), puis écoule tes stocks.',
  'Pousse l’accumulation : la tension de crise naîtra des stocks, de la dette et du chômage.',
];
function objHint(){ return OBJ_HINTS[state.objectifIndex]||''; }
const OBJ_GENERIQUE = {titre:'Accumuler', concept:null,
   but:'Continue d’accumuler : le circuit n’a pas de terme.',
   court:'Accumuler encore', rew:'+ capital', risk:'les contradictions s’accumulent', ok:s=>true,
   gauge:s=>`Argent : ${money(s.argent)} · Stade : ${state.niveauVille}`,
   manque:s=>'',
   lecture:'L’accumulation est sans terme : le capital ne connaît pas le « assez ».'};

function objectifCourant(){
  if(gamePhase==='precapital') return OBJ_PRECAPITAL;
  return OBJECTIFS[state.objectifIndex] || OBJ_GENERIQUE;
}

// Sous-objectifs de la phase 0 (Argent dormant)
const SOUS_OBJ_0 = [
  {t:'Construire l’atelier',             ok:()=>state.buildings.atelier>0},
  {t:'Acheter outils et matières',       ok:()=>state.buildings.outils>0},
  {t:'Assister à la clôture des communs',ok:()=>state.buildings.travail>0},
  {t:'Embaucher le premier ouvrier',     ok:()=>state.travailleurs>0},
  {t:'Produire la première marchandise', ok:()=>state.firstProduced},
  {t:'Vendre la première marchandise',   ok:()=>state.firstSold},
];
function sousObjHTML(){
  return SOUS_OBJ_0.map(o=>`<div class="so ${o.ok()?'done':''}">${o.ok()?'✓':'○'} ${o.t}</div>`).join('');
}

function makeCircuitStepButton(c, cls, label, labelClass, diagInfo){
  const d=document.createElement('button');
  d.type='button'; d.className=cls; d.dataset.sym=c.sym;
  const info = diagInfo || circuitDiagnostic(c.sym,state);
  d.title = `${c.sym} — ${c.full} · ${info.alert?'alerte : '+info.reasons.join(' / '):'pas de tension majeure'}`;
  d.innerHTML=`<span class="sym">${c.sym}</span><span class="${labelClass}">${label}</span>`;
  d.addEventListener('click',()=>openCircuitInfo(c.sym));
  d.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openCircuitInfo(c.sym); }});
  return d;
}
function renderCircuitBar(){
  const el=document.getElementById('circuit'); el.innerHTML='';
  el.classList.toggle('fonda', gamePhase==='precapital');
  if(typeof gameMode!=='undefined' && gameMode==='socialFormation'){
    CIRCUIT.forEach((c,i)=>{
      if(i>0){ const a=document.createElement('span'); a.className='arr'; a.textContent='→'; el.appendChild(a); }
      const info=circuitDiagnostic(c.sym,state);
      const d=makeCircuitStepButton(c,'stp done'+(info.alert?' alert':''),displayCircuitStep(c),'nm',info);
      el.appendChild(d);
    });
    return;
  }
  if(gamePhase==='precapital'){
    // La fondation en trois actes : on voit d'un coup d'œil où l'on en est.
    const nowId=(PRECAPITAL_STEPS.find(s=>!s.done())||{}).id;
    FONDATION.forEach(a=>{
      const g=document.createElement('div');
      g.className='act'+(a.steps.every(s=>s.done())?' done':(a.steps.some(s=>s.id===nowId)?' now':''));
      g.innerHTML=`<div class="ah"><span class="an">${a.acte}</span>${a.nom}</div>`;
      const row=document.createElement('div'); row.className='ar';
      a.steps.forEach((s,i)=>{
        if(i>0){ const ar=document.createElement('span'); ar.className='arr'; ar.textContent='→'; row.appendChild(ar); }
        const d=document.createElement('div');
        d.className='stp'+(s.done()?' done':'')+(s.id===nowId?' now':'');
        d.innerHTML=`<span class="sym">${s.sym}</span><span class="full">${s.nm}</span>`;
        row.appendChild(d);
      });
      g.appendChild(row); el.appendChild(g);
    });
    return;
  }
  const showFull = state.cycle===0;   // premier circuit réel : noms complets
  CIRCUIT.forEach((c,i)=>{
    if(i>0){ const a=document.createElement('span'); a.className='arr'; a.textContent='→'; el.appendChild(a); }
    const info=circuitDiagnostic(c.sym,state);
    const label = showFull ? `${c.sym} — ${c.full}` : displayCircuitStep(c);
    const cls = showFull ? 'full' : 'nm';
    const d=makeCircuitStepButton(c,'stp'+(i<step?' done':'')+(i===step?' now':''),label,cls,info);
    el.appendChild(d);
  });
}
function renderQuest(){
  const o=objectifCourant();
  set('q-cycle', gamePhase==='precapital' ? 'Fondation' : 'Cycle '+(state.cycle+1));
  set('q-rew',o.rew); set('q-risk',o.risk);
  const c=CIRCUIT[step];
  if(gamePhase==='precapital'){
    set('q-goal','Suis la balise rouge : chaque geste de la fondation a son lieu.');
    const tz=precapitalTargetZone();
    const nextLine = tz ? `Prochaine étape : <b>${precapitalZoneLabel(tz)}</b>` : 'Tout est réuni — vends la première marchandise.';
    document.getElementById('q-next').innerHTML=
      `<div class="solist">${sousObjHTML()}</div>${nextLine}`;
  } else {
    set('q-goal',o.but);
    const g = o.gauge ? `<div class="qgauge">${o.gauge(state)}</div>` : '';
    document.getElementById('q-next').innerHTML=`${g}Prochaine étape : <b>${displayZoneName(c.zone)} (${c.sym})</b>`;
  }
}

/* ---- balise lumineuse au-dessus du prochain lieu ---- */
let circuitLine=null;
function buildCircuitLine(){
  if(circuitLine){ scene.remove(circuitLine); }
  const g=new THREE.Group();
  const pts=CIRCUIT.map(c=>{ const z=zones.find(zz=>zz.name===c.zone); return z?z.pos:null; }).filter(Boolean);
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length];
    const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz);
    // M1c — peinture au sol : ambre désaturé, jamais émissive (sous threshold bloom)
    const seg=box(0.5,0.04,len,0x8a6f3a,(a.x+b.x)/2,0.05,(a.z+b.z)/2,false);
    seg.rotation.y=Math.atan2(dx,dz);
    seg.material.transparent=true; seg.material.opacity=0.42;
    seg.material.emissiveIntensity=0;
    g.add(seg);
  }
  g.visible=false; circuitLine=g; scene.add(g);
}
let targetMarker=null;
function buildTargetMarker(){
  const g=new THREE.Group();
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(0.6,1.8,16,12,1,true),
    new THREE.MeshBasicMaterial({color:COL.rouge,transparent:true,opacity:.32,side:THREE.DoubleSide,depthWrite:false}));
  beam.position.y=8; g.add(beam);
  const cone=new THREE.Mesh(new THREE.ConeGeometry(1.5,2.6,4),
    new THREE.MeshStandardMaterial({color:COL.rouge,flatShading:true}));
  cone.rotation.x=Math.PI; cone.position.y=16; g.add(cone);
  g.userData.beam=beam; g.userData.cone=cone;
  targetMarker=g; scene.add(g);
  buildGroundArrow();
}
/* trace pointillée discrète au sol, du chariot vers le prochain lieu (remplace l'ancienne flèche) */
let groundArrow=null;
function buildGroundArrow(){
  const g=new THREE.Group();
  for(let i=0;i<7;i++){
    // M1c — pointillés peinture au sol : ambre désaturé, jamais émissive
    const dash=box(0.42,0.04,1.25,0x8a6f3a,0,0.06,0,false);
    dash.material.transparent=true; dash.material.opacity=0;
    dash.material.emissiveIntensity=0;
    g.add(dash);
  }
  groundArrow=g; scene.add(g);
}
function updateGroundArrow(){
  if(!groundArrow) return;
  let targetName = gamePhase==='precapital' ? precapitalTargetZone() : (gameOver?null:CIRCUIT[step].zone);
  if(gameOver || !targetName){ groundArrow.visible=false; return; }
  const z=zones.find(zz=>zz.name===targetName);
  if(!z){ groundArrow.visible=false; return; }
  const px=Vehicle.pos.x, pz=Vehicle.pos.z;
  const dx=z.pos.x-px, dz=z.pos.z-pz, dist=Math.hypot(dx,dz);
  if(dist<9){ groundArrow.visible=false; return; }    // déjà sur place
  groundArrow.visible=true;
  const ang=Math.atan2(dx,dz);
  const n=groundArrow.children.length, reach=Math.min(dist-6, 24);
  for(let i=0;i<n;i++){
    const f=(i+1)/(n+1);
    const d=6+f*reach;
    const dash=groundArrow.children[i];
    dash.position.set(px+Math.sin(ang)*d, 0.06, pz+Math.cos(ang)*d);
    dash.rotation.y=ang;
    dash.material.opacity=0.08+0.14*(1-f)+0.05*Math.max(0,Math.sin(t*3 - i*0.6)); // discret, léger pouls
  }
}
function moveTargetMarker(){
  if(!targetMarker||gameOver) return;
  if(typeof gameMode!=='undefined' && gameMode==='socialFormation'){ targetMarker.visible=false; if(typeof groundArrow!=='undefined'&&groundArrow) groundArrow.visible=false; return; }
  let targetName;
  if(gamePhase==='precapital'){ targetName=precapitalTargetZone(); if(!targetName){ targetMarker.visible=false; return; } }
  else targetName=CIRCUIT[step].zone;
  const z=zones.find(zz=>zz.name===targetName);
  if(z){ targetMarker.position.set(z.pos.x,0,z.pos.z); targetMarker.visible=true; }
}

/* ===================================================================
   Conséquences visibles sur la carte
   stocks → caisses · chômage → silhouettes · colère → banderoles
   grève → usine bloquée · machines → machines visibles · crise → alerte
   =================================================================== */
function clearLayer(group,key){
  if(!group) return;
  for(let i=group.children.length-1;i>=0;i--){
    if(group.children[i].userData && group.children[i].userData.layer===key) group.remove(group.children[i]);
  }
}
function tagLayer(obj,key){ obj.traverse?.(o=>o.userData&&(o.userData.layer=key)); obj.userData.layer=key; return obj; }

function updateConsequences(){
  // --- machines visibles dans l'usine ---
  const us=zoneGroups['Usine'];
  if(us){ clearLayer(us,'mach');
    const extra=Math.max(0,state.niveauMachine-1);
    for(let i=0;i<Math.min(6,extra);i++){
      const m=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1.4,10),
        new THREE.MeshStandardMaterial({color:0x4b4438,metalness:.35,roughness:.6,flatShading:true}));
      m.rotation.z=Math.PI/2; m.position.set(-5+i*2.1,1.2,5.5); m.userData.layer='mach'; m.castShadow=true; us.add(m);
    }
    // M-Peuple : chômage à l'usine + ouvriers au travail sont désormais
    // gérés par PeuplePop (file marché du travail / ouvrier-emploi à
    // l'usine). On NETTOIE les anciennes couches pour effacer toute figure
    // résiduelle laissée par une version antérieure.
    clearLayer(us,'chom');
    clearLayer(us,'travail');
    // --- grève : barrière qui bloque l'usine ---
    clearLayer(us,'greve');
    if(state.enGreve){
      const bar=box(14,0.5,0.5,0x8a2c1d,0,2.4,7,false); bar.userData.layer='greve'; us.add(bar);
      for(const x of [-6,6]){ const p=box(0.4,3,0.4,0x241f17,x,1.5,7,false); p.userData.layer='greve'; us.add(p); }
      const sign=makeLabel('GRÈVE'); sign.scale.set(7,1.5,1); sign.position.set(0,5.5,7); sign.userData.layer='greve'; us.add(sign);
    }
  }
  // --- stocks : caisses qui s'entassent dans l'entrepôt, débordent dehors si trop hautes ---
  const ent=zoneGroups['Entrepôt'];
  if(ent){ clearLayer(ent,'stock');
    const n=Math.min(14,Math.floor(state.stocks/18));
    for(let i=0;i<n;i++){
      const col=i%3? 0x8a6b49:0x9a7a55;
      const cx=-6+(i%5)*2.4, cz=-3+Math.floor(i/5%2)*2.4, cy=1.1+(i>=10?2.2:0);
      const crate=box(2.1,2.1,2.1,col,cx,cy,cz); crate.userData.layer='stock'; ent.add(crate);
    }
    // débordement : au-delà du seuil, les caisses s'entassent DEHORS, devant l'entrepôt
    const over=Math.min(10,Math.floor(Math.max(0,state.stocks-180)/22));
    for(let i=0;i<over;i++){
      const cx=-9+(i%5)*2.5, cz=10+Math.floor(i/5)*2.5;
      const crate=box(2.1,2.1,2.1,0x7d6242,cx,1.1,cz); crate.userData.layer='stock'; crate.rotation.y=(i*0.3); ent.add(crate);
    }
  }
  // M-Peuple : le quartier ouvrier est désormais peuplé par PeuplePop
  // (ouvriere-rue + ouvrier-passant, densité ∝ emploi + niveau quartier).
  // On nettoie l'ancienne couche 'qpop' pour effacer toute silhouette
  // résiduelle.
  const qPop = zoneGroups['Quartier ouvrier'];
  if(qPop){ clearLayer(qPop,'qpop'); }
  // --- colère : quartier qui s'assombrit + banderoles au-delà d'un seuil ---
  const q=zoneGroups['Quartier ouvrier'];
  if(q){ clearLayer(q,'col'); clearLayer(q,'dark');
    // assombrissement : voile sombre au sol, d'autant plus marqué que la colère monte
    if(state.colere>0.15){
      const dark=new THREE.Mesh(new THREE.CircleGeometry(9,32),
        new THREE.MeshBasicMaterial({color:0x1a1712,transparent:true,opacity:Math.min(0.55,state.colere*0.6),depthWrite:false}));
      dark.rotation.x=-Math.PI/2; dark.position.y=0.05; dark.userData.layer='dark'; q.add(dark);
    }
    // banderoles seulement si la colère dépasse le seuil
    const n = state.colere>0.4 ? Math.min(5,Math.floor(state.colere*6)) : 0;
    for(let i=0;i<n;i++){
      const ban=box(4.2,1.1,0.12,0x8a2c1d,-5+i*2.3,3.4+(i%2)*1.2,-4); ban.userData.layer='col';
      ban.rotation.z=(i%2?1:-1)*0.05; q.add(ban);
      const pole=box(0.18,3.6,0.18,0x3a2f22,-7+i*2.3,1.8,-4,false); pole.userData.layer='col'; q.add(pole);
    }
  }
  // --- crise : alerte sur la banque + voile rouge ---
  const bk=zoneGroups['Banque'];
  const crise=(state.d.risqueCrise||0)>0.7 || state.d.declenche;
  if(bk){ clearLayer(bk,'alert'); clearLayer(bk,'detteviz');
    // v47 — la banque devient menaçante quand la dette pèse : ombre au sol ∝ dette/plafond.
    const lev=state.dette/Math.max(1,state.plafondCredit||600);
    if(lev>0.35){
      const sh=new THREE.Mesh(new THREE.CircleGeometry(10,32),
        new THREE.MeshBasicMaterial({color:0x1a1712,transparent:true,opacity:Math.min(0.5,lev*0.55),depthWrite:false}));
      sh.rotation.x=-Math.PI/2; sh.position.y=0.05; sh.userData.layer='detteviz'; bk.add(sh);
      if(lev>0.7){ const dl=makeLabel('DETTE'); dl.scale.set(5,1.3,1); dl.position.set(0,12,0); dl.userData.layer='detteviz'; bk.add(dl); }
    }
    if(crise){
      const beacon=new THREE.Mesh(new THREE.SphereGeometry(0.9,12,12),
        new THREE.MeshStandardMaterial({color:COL.rouge,emissive:0x8a2c1d,emissiveIntensity:.8,flatShading:true}));
      beacon.position.set(0,14,0); beacon.userData.layer='alert'; beacon.userData.pulse=true; bk.add(beacon);
    }
  }
  // --- crise : prix barrés au marché de vente ---
  const mv=zoneGroups['Marché de vente'];
  if(mv){ clearLayer(mv,'crisemkt');
    if(crise){
      const sign=makeLabel('PRIX ✗'); sign.scale.set(6,1.4,1); sign.position.set(0,7,0);
      sign.userData.layer='crisemkt'; mv.add(sign);
    }
    // v47/M-Peuple — la demande faible = marché qui se vide. Les clients
    // sont peuplés par PeuplePop (rôle 'client', proportionnel au taux de
    // vente). Ici on ne garde que l'enseigne ATONE et on nettoie l'ancienne
    // couche 'demande' (anti-résidus).
    clearLayer(mv,'demande');
    const tv=(state.d&&state.d.tauxVente!=null)?state.d.tauxVente:1;
    if(tv<0.6 && !crise){
      const sg=makeLabel('MARCHÉ ATONE'); sg.scale.set(7,1.4,1); sg.position.set(0,7,0);
      sg.userData.layer='demande'; mv.add(sg);
    }
  }
  // --- faillites de concurrents : panneaux FAILLITE au-dessus de la bourse ---
  const bo=zoneGroups['Bourse'];
  if(bo){ clearLayer(bo,'faillite');
    const morts=(state.competitors||[]).filter(c=>!c.vivant);
    morts.slice(0,3).forEach((c,i)=>{
      const sign=makeLabel('FAILLITE'); sign.scale.set(6,1.4,1);
      sign.position.set(-5+i*5,8+i*1.6,0); sign.userData.layer='faillite'; bo.add(sign);
    });
  }
  // M-Peuple : parvis Bourse, dockers, attroupement, paysans Terres
  // communes — tous gérés par PeuplePop (lectures de capital, port,
  // colère, enclosure). Ici on se borne à NETTOYER les anciennes couches
  // pour qu'aucune figure résiduelle ne subsiste si une session
  // antérieure en avait laissé.
  if(bo){ clearLayer(bo,'flaneurs'); }
  const po = zoneGroups['Port · Marché mondial'];
  if(po){ clearLayer(po,'dockers'); }
  if(us){ clearLayer(us,'attroup'); }
  const tc = zoneGroups['Terres communes'];
  if(tc){ clearLayer(tc,'paysans'); }
  document.getElementById('crisisVeil').classList.toggle('on', !!state.d.declenche || (state.d.risqueCrise||0)>0.85);
  document.getElementById('crisisTag').classList.toggle('on', !!state.d.declenche);

  renderLeviers();
}

/* ===================================================================
   VILLE CAPITALISTE — niveaux de bâtiments, améliorations, évolution visuelle
   Accumuler → construire → transformer → contredire.
   =================================================================== */
const STAGES = [
  {n:'Argent dormant',     contradiction:''},
  {n:'Atelier',            contradiction:'La production naît — et avec elle la dépendance au salariat.'},
  {n:'Manufacture',        contradiction:'Plus de production — mais la discipline et la fatigue s’installent.'},
  {n:'Grande industrie',   contradiction:'Les machines produisent en masse — mais aussi du chômage et de la dette.'},
  {n:'Ville industrielle', contradiction:'Le marché s’élargit — mais la surproduction menace.'},
  {n:'Capital financier',  contradiction:'Le crédit accélère l’accumulation — mais rend la crise plus violente.'},
  {n:'Marché mondial',     contradiction:'Le capital conquiert le monde — mais étend la crise à l’échelle globale.'},
];
function computeNiveauVille(){
  if(gamePhase==='precapital' || !state.productionActive) return 0;
  const b=state.buildings, s=state;
  let niv=1;                                                                   // 1 — Atelier
  if(s.cyclesProfitables>=2 && s.travailleurs>=4 && s.argent>=250) niv=Math.max(niv,2);            // 2 — Manufacture
  if(b.usine>0 && s.niveauMachine>=2) niv=Math.max(niv,3);                                          // 3 — Grande industrie
  if(b.quartier>0 && b.entrepot>0 && b.rails>0 && (s.travailleurs>=8 || s.populationActive>=12))
    niv=Math.max(niv,4);                                                                            // 4 — Ville industrielle
  if(b.bourse>0) niv=Math.max(niv,5);                                                               // 5 — Capital financier (préparé)
  if(b.port>0)   niv=Math.max(niv,6);                                                               // 6 — Marché mondial (préparé)
  return niv;
}
function updateVilleBadge(){
  let niv=state.niveauVille, st=STAGES[niv]||STAGES[0];
  if(typeof gameMode!=='undefined' && gameMode==='socialFormation'){ niv=state.age||1; st=STAGES[niv]||st; } // cohérence avec l'âge du panneau et du journal
  const g=id=>document.getElementById(id);
  if(g('ville-niv')) g('ville-niv').textContent=niv;
  if(g('ville-stade')) g('ville-stade').textContent=st.n;
}
// recalcule le stade (MONOTONE : ne redescend jamais) ; si montée, renvoie le stade franchi
function refreshNiveauVille(){
  const avant=state.niveauVille;
  const niv=Math.max(avant, computeNiveauVille());
  state.niveauVille=niv; updateVilleBadge();
  return niv>avant ? STAGES[niv] : null;
}
// à appeler après construction / embauche / machine : met à jour le stade ET la carte
function updateCapitalStage(){
  const monte=refreshNiveauVille();
  if(monte){ updateBuildings(); updateZoneVisibility(); updateConsequences(); }
  return monte;
}

// Améliorations disponibles (bâtiment, coût, effet éco, conséquence, transformation, lecture marxienne)
const UPGRADES = [
  // --- AMÉLIORATIONS FONDATRICES (phase 0 : créer les conditions du capital) ---
  {id:'atelier', b:'atelier', t:'Construire l’atelier', cost:150, once:true, founding:true,
   avail:()=>state.buildings.atelier===0,
   eff:'un lieu de production', cq:'l’argent commence à se fixer dans des moyens de production', vis:'un atelier s’élève sur le terrain vide',
   marx:'L’argent commence à se fixer dans des moyens de production : il cesse d’être oisif.',
   apply:s=>{ s.buildings.atelier=1; s.buildings.usine=Math.max(1,s.buildings.usine); }},
  {id:'outils', b:'outils', t:'Acheter outils et matières', cost:100, once:true, founding:true,
   avail:()=>state.buildings.atelier>0 && state.buildings.outils===0,
   eff:'l’atelier est équipé', cq:'les moyens de production ne créent pas seuls de la valeur', vis:'caisses, outils et matières dans l’atelier',
   marx:'Les moyens de production transmettent leur valeur au produit, mais n’en créent aucune par eux-mêmes.',
   apply:s=>{ s.buildings.outils=1; s.niveauMachine=Math.max(1,s.niveauMachine); }},
  // La clôture des communs ne se joue pas, elle se REGARDE : ce n'est pas l'acte
  // du capitaliste individuel mais celui de la loi et du propriétaire. Elle ne
  // coûte rien au joueur — c'est l'histoire qui travaille pour lui — et c'est
  // elle qui met des vendeurs de force de travail sur la place d'embauche.
  {id:'enclosure', b:'travail', t:'Assister à la clôture des communs', cost:0, once:true, founding:true,
   avail:()=>state.buildings.atelier>0 && state.buildings.outils>0 && state.buildings.travail===0,
   eff:'trois paysans sans terre à la place d’embauche', cq:'la force de travail devient une marchandise', vis:'les haies se ferment, les paysans quittent les champs',
   marx:'Ce n’est pas toi qui clôtures. Mais sans cette séparation des producteurs et de leurs moyens de production, personne n’aurait de force de travail à vendre.',
   apply:s=>{ s.buildings.travail=Math.max(1,s.buildings.travail); s.populationActive+=3; s.enclos=true; }},
  {id:'embauche0', t:'Embaucher le premier ouvrier', cost:0, founding:true,
   avail:()=>state.populationActive>0 && state.travailleurs===0,
   eff:'un ouvrier, 5 £ par cycle', cq:'le capital achète la force de travail', vis:'un ouvrier apparaît dans l’atelier',
   marx:'Tu n’achètes pas son travail : tu achètes le droit de le faire travailler dix heures. C’est la seule marchandise dont l’usage produit plus de valeur qu’elle ne coûte.',
   apply:s=>{ s.travailleurs=Math.max(1,s.travailleurs); }},
  {id:'produire', t:'Produire la première marchandise', cost:0, founding:true,
   avail:()=>state.buildings.atelier>0 && state.buildings.outils>0 && state.travailleurs>0 && !state.firstProduced,
   eff:'1re production', cq:'le travail vivant transforme les matières en marchandise', vis:'une marchandise sort de l’atelier',
   marx:'Dans l’atelier, l’ouvrier ajoute par son travail plus de valeur qu’il n’en coûte : c’est là, et non sur le marché, que naît la plus-value.',
   apply:s=>{ precapitalProduce(); }},
  {id:'vendre', t:'Vendre la première marchandise', cost:0, founding:true, final:true,
   avail:()=>state.firstProduced && !state.firstSold,
   eff:'1re vente — l’argent revient augmenté', cq:'la valeur produite se réalise en argent', vis:'la marchandise part au marché local',
   marx:'La marchandise se change en argent : la plus-value, jusque-là virtuelle, est enfin réalisée. A est devenu A′.',
   apply:s=>{ precapitalSell(); }},
  // --- AMÉLIORATIONS AVANCÉES ---
  {id:'usine', b:'usine', t:'Améliorer l’usine', cost:250, repeat:true,
   eff:'+ productivité', cq:'+ capital constant, + risque de chômage', vis:'une cheminée de plus s’élève sur l’usine',
   marx:'La productivité augmente, mais la domination du travail vivant par la machine s’approfondit.',
   apply:s=>{ s.buildings.usine++; s.niveauMachine++; }},
  {id:'machine', b:'usine', t:'Installer une machine', cost:300, repeat:true,
   eff:'+ productivité', cq:'+ chômage, + capital constant, + risque de surproduction', vis:'une machine visible apparaît dans l’usine',
   marx:'Chaque machine arrache plus de valeur en moins de temps — et rend une part des bras superflue.',
   apply:s=>{ s.niveauMachine++; }},
  {id:'entrepot', b:'entrepot', t:'Agrandir l’entrepôt', cost:180, repeat:true,
   eff:'+ capacité de stockage', cq:'la surproduction reste, seulement différée', vis:'l’entrepôt grandit, les caisses s’alignent',
   marx:'Stocker permet de retarder le problème, non de le résoudre : la marchandise doit encore se vendre.',
   apply:s=>{ s.buildings.entrepot++; s.stockCapaciteBonus+=120; }},
  {id:'quartier', b:'quartier', t:'Construire des logements ouvriers', cost:150, repeat:true,
   eff:'− tension sociale', cq:'meilleure reproduction de la force de travail', vis:'de nouvelles maisons dans le quartier ouvrier',
   marx:'Reproduire la force de travail devient une condition de la reproduction du capital.',
   apply:s=>{ s.buildings.quartier++; s.reproSocial=Math.min(0.18,s.reproSocial+0.05); s.colere=clamp(s.colere-0.12); }},
  {id:'marche', b:'marche', t:'Développer le marché', cost:220, repeat:true,
   eff:'+ demande solvable', cq:'+ concurrence, + circulation', vis:'le marché s’étend, de nouveaux stands',
   marx:'Élargir le marché repousse les limites de la vente — mais y attire d’autres capitaux.',
   apply:s=>{ s.buildings.marche++; s.demandeBonus+=80; }},
  {id:'travail', b:'travail', t:'Étendre le marché du travail', cost:160, repeat:true,
   eff:'+ main-d’œuvre disponible', cq:'+ armée de réserve, pression sur les salaires', vis:'la file d’ouvriers s’allonge',
   marx:'Plus de bras disponibles, c’est une armée de réserve qui pèse à la baisse sur tous les salaires.',
   apply:s=>{ s.buildings.travail++; s.populationActive+=2; }},
  {id:'banque', b:'banque', t:'Agrandir la banque', cost:280, repeat:true,
   eff:'+ plafond de crédit', cq:'crédit facile, mais crise plus violente', vis:'la banque s’élève, son fronton dore',
   marx:'Le crédit accélère l’accumulation, mais il rend la crise plus violente.',
   apply:s=>{ s.buildings.banque++; s.creditBonus+=250; }},
  {id:'rails', b:'rails', t:'Construire des rails', cost:350, repeat:true,
   eff:'+ vitesse de circulation, + ventes', cq:'extension du marché', vis:'des rails relient usine, entrepôt et marché',
   marx:'Accélérer la circulation, c’est raccourcir le temps où le capital dort : le marché s’étend avec les voies.',
   apply:s=>{ s.buildings.rails++; s.railsBonus=Math.min(0.5,s.railsBonus+0.16); }},
  {id:'port', b:'port', t:'Ouvrir le port', cost:500, once:true,
   eff:'+ débouchés, + matières premières', cq:'dépendance au marché mondial', vis:'un quai, un bateau, des caisses d’import/export',
   marx:'Le capital ne tient pas dans une frontière : le marché mondial est à la fois débouché et dépendance.',
   apply:s=>{ s.buildings.port=1; s.portOuvert=true; s.demandeBonus+=120; }},
  {id:'bourse', b:'bourse', t:'Ouvrir la bourse', cost:450, once:true,
   eff:'+ crédit, + capital fictif', cq:'spéculation, risque financier', vis:'la bourse s’anime, les bulles dorées gonflent',
   marx:'Le capital fictif promet de l’argent qui fait des petits sans passer par la production — jusqu’au krach.',
   apply:s=>{ s.buildings.bourse=1; s.bourseActive=true; s.creditBonus+=150; }},
];
function upgradeCost(u){
  if(u.once || u.founding) return u.cost;
  const lvl = u.b==='usine'&&u.id==='machine' ? state.niveauMachine : (state.buildings[u.b]||1);
  return Math.round(u.cost + (lvl-1)*u.cost*0.55);
}
function upgradeAvailable(u){
  if(u.avail) return u.avail();
  if(u.once && state.buildings[u.b]>0) return false;   // déjà construit
  return true;
}
function recomputeProduction(){
  state.productionActive =
    state.buildings.atelier > 0 &&
    state.buildings.outils  > 0 &&
    state.travailleurs      > 0;
}

/* ---- Phase 0 jouée dans l'espace : chaque action fondatrice a son lieu ---- */
const PRECAP_ZONE_CARDS = {
  'Usine':            ['atelier','produire'],
  'Marché des moyens':['outils'],
  'Terres communes':  ['enclosure'],
  'Marché du travail':['embauche0'],
  'Marché de vente':  ['vendre'],
};
// carte fondatrice disponible à cette zone (selon l'avancement), sinon null
function precapitalAction(zoneName){
  const ids=PRECAP_ZONE_CARDS[zoneName]; if(!ids) return null;
  for(const id of ids){ const u=UPGRADES.find(x=>x.id===id);
    if(u && (u.avail?u.avail():!(u.once&&state.buildings[u.b]>0))) return u; }
  return null;
}
// prochaine zone fondatrice à viser (pour la balise au sol)
function precapitalTargetZone(){
  if(state.buildings.atelier===0) return 'Usine';
  if(state.buildings.outils===0)  return 'Marché des moyens';
  if(state.buildings.travail===0) return 'Terres communes';
  if(state.travailleurs===0)      return 'Marché du travail';
  if(!state.firstProduced)        return 'Usine';
  if(!state.firstSold)            return 'Marché de vente';
  return null;
}
// label “de terrain” affiché pendant la phase 0
function precapitalZoneLabel(name){
  if(name==='Usine') return state.buildings.atelier===0 ? 'Terrain vide' : 'Atelier';
  if(name==='Marché des moyens') return 'Marché local — outils et matières';
  if(name==='Terres communes')   return 'Les terres communes';
  if(name==='Marché du travail') return state.buildings.travail===0 ? 'Place d’embauche — vide' : 'Place d’embauche';
  if(name==='Marché de vente')   return 'Marché de vente';
  return name;
}
// invite contextuelle de la phase 0 selon l'action disponible
function precapitalPrompt(u){
  switch(u.id){
    case 'atelier':   return 'construire l’atelier';
    case 'outils':    return 'acheter outils et matières';
    case 'enclosure': return 'regarder les communs';
    case 'embauche0': return 'embaucher un ouvrier';
    case 'produire':  return 'lancer la production';
    case 'vendre':    return 'vendre les marchandises';
    default:          return 'agir';
  }
}
// Ce que le joueur VIENT DE FAIRE, avec les chiffres de sa propre partie. Reste
// affiché dans le carnet jusqu'au geste suivant — pas de minuterie, pas de
// panneau qui se replie : on doit pouvoir le relire.
let fondaRecap=null;
function fondationRecap(u, avant){
  const s=state, cout=avant-s.argent, reste=money(s.argent);
  switch(u.id){
    case 'atelier':   return {t:'Tu as construit l’atelier.', n:`− ${money(cout)} · reste ${reste}`,
      m:'Une part de ton argent s’est fixée dans des murs. Ils ne reviendront pas comme argent — et ne produisent rien seuls.'};
    case 'outils':    return {t:'Tu as acheté outils et matières.', n:`− ${money(cout)} · reste ${reste}`,
      m:'L’atelier est équipé. Les moyens de production transmettent leur valeur au produit, ils n’en créent aucune. Il manque le travail.'};
    case 'enclosure': return {t:'Les communs sont clôturés.', n:`0 £ · ${s.populationActive} paysans sans terre à la place d’embauche`,
      m:'Tu n’as rien payé : ce n’est pas toi qui as clôturé. Mais sans cette séparation, personne n’aurait eu de force de travail à te vendre.'};
    case 'embauche0': return {t:'Tu as embauché un ouvrier.', n:`salaire ${money(s.salaire)} par cycle, avancé à la production`,
      m:`Tu n’as pas acheté son travail : tu as acheté le droit de le faire travailler ${s.heures} heures. Toute la question est dans cet écart.`};
    case 'produire':  return {t:`Tu as produit ${s._pcQ} marchandises.`, n:`avancé ${money2((s._pcV||0)+(s._pcMat||0))} (salaire ${money2(s._pcV||0)} + matières ${money2(s._pcMat||0)}) · reste ${money2(s.argent)}`,
      m:'La valeur est dans les caisses, pas dans ton coffre. Tant qu’elles ne sont pas vendues, elles ne valent rien pour toi.'};
  }
  return {t:u.t+'.', n:'', m:u.marx||''};
}
// exécuter une action fondatrice DANS L'ESPACE (sans passer par le panneau)
function doFounding(u){
  const cost=upgradeCost(u);
  if(state.argent<cost){
    pushLog('Fondation', `Il manque ${money(cost-state.argent)} pour ${u.t.toLowerCase()}.`,'warn');
    return;
  }
  const avant=state.argent;
  state.argent-=cost; u.apply(state); recomputeProduction();
  if(u.final){ state.firstSold=true; }
  pushLog('Fondation', `${u.t}${cost>0?` (−${money(cost)})`:''}. ${u.eff}.`,'plain');
  updateBuildings(); updateZoneVisibility(); updateConsequences(); updateHUD();
  renderCircuitBar(); renderQuest();
  // Après le geste : le carnet dit ce qu'on vient de faire, et l'on sauvegarde —
  // en fondation il n'y a pas encore de cycle, chaque geste EST la progression.
  const after=()=>{ fondaRecap=fondationRecap(u,avant); moveTargetMarker(); tutorialCoachRefresh(true);
    if(typeof SaveGame!=='undefined') SaveGame.autosave(); };
  // effets visibles sur la carte (le monde change avant l'explication)
  if(u.id==='atelier'){ fxPuff('Usine'); fxHalo('Usine'); flashTimer=0.5; animateConstruction(zoneGroups['Usine']); floatText('atelier construit',{x:zonePos('Usine').x,y:9,z:zonePos('Usine').z},'gain'); }
  else if(u.id==='outils'){ fxPuff('Usine'); floatText('moyens de production',{x:zonePos('Usine').x,y:8,z:zonePos('Usine').z},'gain'); }
  else if(u.id==='enclosure'){
    // L'événement se REGARDE : la caméra quitte le chariot et fait le tour des
    // champs pendant que les paysans les quittent ; puis la carte raconte.
    fxHalo('Marché du travail'); animateConstruction(zoneGroups['Marché du travail']);
    const carte=()=>showConcept({...ENCLOSURE_SCREEN, onClose:after});
    if(!CinemaSequences.playEnclosure(carte)) carte();
    return;
  }
  else if(u.id==='embauche0'){ fxHalo('Usine'); floatText('ouvrier embauché',{x:zonePos('Marché du travail').x,y:9,z:zonePos('Marché du travail').z},'social'); }
  else if(u.id==='produire'){ fxPing('Marché de vente'); floatText('+ marchandises',{x:zonePos('Usine').x,y:9,z:zonePos('Usine').z},'gain'); }   // clignote la prochaine destination
  if(u.final){ fxCrate('Usine','Marché de vente'); fondaRecap=null; birthOfCapital(); return; } // la vente fait naître le capital
  after();
}

/* ---- transformations visuelles (couche 'lvl', reconstruite à chaque fois) ---- */
let railsGroup=null;
function addLvl(group,mesh){ mesh.userData.layer='lvl'; group.add(mesh); return mesh; }
function goldHalo(group,r=8.8){
  const ring=new THREE.Mesh(new THREE.RingGeometry(r,r+0.7,40),
    new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:.5,side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2; ring.position.y=0.06; addLvl(group,ring);
}
function updatePrecapVisuals(){
  const ug=zoneGroups['Usine'];
  if(ug){
    clearLayer(ug,'pc');
    if(state.buildings.atelier>0){
      // halo doré (bref/contextuel) autour de l'atelier naissant
      if(gamePhase==='precapital'){
        const ring=new THREE.Mesh(new THREE.RingGeometry(8.6,9.3,40),
          new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:.4,side:THREE.DoubleSide}));
        ring.rotation.x=-Math.PI/2; ring.position.y=0.07; ring.userData.layer='pc'; ug.add(ring);
      }
      if(state.buildings.outils>0){                  // outils, caisses, matières
        const c1=box(1.8,1.3,1.8,COL.brun,-4.5,0.65,3.5,false); c1.userData.layer='pc'; ug.add(c1);
        const c2=box(1.5,1.0,1.5,COL.brun,-2.6,0.5,4.6,false);  c2.userData.layer='pc'; ug.add(c2);
        const c3=box(1.2,0.8,1.2,COL.pierre,-5.4,0.4,5.0,false); c3.userData.layer='pc'; ug.add(c3);
      }
      // M-Peuple-g : SUPPRIMÉ — c'était un ouvrier-statue en box (corps
      // 0.9×2.0×0.7 COL.bleu + tête 0.7³ 0xc9a06a) ajouté dès que
      // state.travailleurs>0. Doublon avec le 'ouvrier-emploi' de
      // PeuplePop (figures procédurales animées à l'usine).
      if(state.firstProduced && !state.firstSold){    // la première marchandise
        const m=box(1.9,1.9,1.9,COL.or,0.5,0.95,5.2,false); m.userData.layer='pc'; ug.add(m);
      }
    }
  }
  // M-Peuple-g : SUPPRIMÉ — la "Place d'embauche : 2-3 silhouettes" était
  // un ensemble de 3 box-statues (corps 0.8×1.9×0.6 COL.froid + tête
  // 0.6³ 0xb9966a) plantées en avant du bureau dès que buildings.travail>0.
  // Couleurs pâles + posture raide = exactement les "statues" décrites.
  // La place est désormais peuplée par PeuplePop ('file-chomeurs'
  // ∝ chômage réel, figures procédurales animées). On nettoie la couche
  // 'pc' au cas où une session antérieure en aurait laissé.
  const tg=zoneGroups['Marché du travail'];
  if(tg){ clearLayer(tg,'pc'); }
}
function updateBuildings(){
  const b=state.buildings, zg=zoneGroups;
  updatePrecapVisuals();
  // Banque : étages dorés + halo
  if(zg['Banque']){ clearLayer(zg['Banque'],'lvl');
    for(let i=1;i<b.banque;i++){ addLvl(zg['Banque'], box(11-i*1.2,2.4,9-i*1.2,COL.or,0,12.4+i*2.4,0)); }
    if(b.banque>1) goldHalo(zg['Banque']);
  }
  // Usine : cheminées supplémentaires (avec fumée)
  if(zg['Usine']){ clearLayer(zg['Usine'],'lvl');
    const extra=Math.min(5,b.usine-1);
    for(let i=0;i<extra;i++){ const x=6+i*2.4;
      addLvl(zg['Usine'], box(1.8,11+i,1.8,COL.charbon,x,(11+i)/2,-2));
      const smoke=new THREE.Mesh(new THREE.SphereGeometry(1.6,8,8),
        new THREE.MeshStandardMaterial({color:0x8a8275,transparent:true,opacity:.5,flatShading:true}));
      smoke.position.set(x,15.5+i,-2); smoke.userData.smoke=true; addLvl(zg['Usine'],smoke);
    }
    // mécanisation : l'usine se remplit de machines à mesure que niveauMachine monte (design qui évolue)
    const nm=Math.min(7,state.niveauMachine||0);
    for(let i=0;i<nm;i++){ const mx=-7+(i%4)*4, mz=4+Math.floor(i/4)*4;
      const unit=box(2.6,2.0,1.8, i<4?COL.fer:COL.charbon, mx,1.0,mz, false); addLvl(zg['Usine'],unit);
      const gear=new THREE.Mesh(new THREE.TorusGeometry(0.9,0.28,6,10),
        new THREE.MeshStandardMaterial({color:COL.or,metalness:0.4,roughness:0.5,flatShading:true}));
      gear.position.set(mx,2.6,mz); gear.rotation.x=Math.PI/2; gear.userData.gear=true; addLvl(zg['Usine'],gear);
    }
    if((state.niveauMachine||0)>=5){ goldHalo(zg['Usine']); }   // grande mécanisation : halo
    else if(b.usine>1) goldHalo(zg['Usine']);
  }
  // Entrepôt : caisses de base supplémentaires + halo
  if(zg['Entrepôt']){ clearLayer(zg['Entrepôt'],'lvl');
    const extra=Math.min(5,b.entrepot-1);
    for(let i=0;i<extra;i++){ addLvl(zg['Entrepôt'], box(2.2,2.2,2.2,0x70583e,-9+i*2.4,1.1,-5)); }
    if(b.entrepot>1) goldHalo(zg['Entrepôt']);
  }
  // Marché : stands supplémentaires
  if(zg['Marché de vente']){ clearLayer(zg['Marché de vente'],'lvl');
    const extra=Math.min(5,b.marche-1);
    const cols=[COL.or,COL.bleu,COL.rouge,COL.brun,COL.vert];
    for(let i=0;i<extra;i++){ addLvl(zg['Marché de vente'], box(2.6,1.5,2,cols[i%5],-5+i*2.6,1,5)); }
    if(b.marche>1) goldHalo(zg['Marché de vente']);
  }
  // Quartier ouvrier : maisons supplémentaires
  if(zg['Quartier ouvrier']){ clearLayer(zg['Quartier ouvrier'],'lvl');
    const extra=Math.min(6,b.quartier-1);
    for(let i=0;i<extra;i++){ const x=-6+i*2.6, z=6+(i%2)*2.4, h=2.8+(i%3)*0.6;
      addLvl(zg['Quartier ouvrier'], box(2.6,h,2.6,COL.froid,x,h/2,z));
      const roof=new THREE.Mesh(new THREE.ConeGeometry(2.1,1.4,4),
        new THREE.MeshStandardMaterial({color:0x4a5763,flatShading:true}));
      roof.position.set(x,h+0.7,z); roof.rotation.y=Math.PI/4; addLvl(zg['Quartier ouvrier'],roof);
    }
  }
  // Marché du travail : file d'ouvriers plus longue
  // M-Peuple-g : SUPPRIMÉ — c'était un empilement box+sphère
  // (corps COL.bleu + tête 0x42525f) ajouté quand buildings.travail≥2.
  // Ces silhouettes raides et claires apparaissaient comme des
  // "statues" alignées devant le bureau d'embauche, sans animation
  // ni rôle simulationnel. La FILE est désormais une lecture vivante
  // de la simulation, gérée par PeuplePop ('file-chomeurs' devant le
  // guichet, ∝ chômage réel, type chomeur procédural, anim idle).
  if(zg['Marché du travail']){ clearLayer(zg['Marché du travail'],'lvl'); }
  // Port : activé -> halo + caisses d'import/export supplémentaires
  if(zg['Port · Marché mondial']){ clearLayer(zg['Port · Marché mondial'],'lvl');
    if(b.port>0){ goldHalo(zg['Port · Marché mondial']);
      const cols=[COL.rouge,COL.bleu,COL.or];
      for(let i=0;i<3;i++) addLvl(zg['Port · Marché mondial'], box(2.4,2,2.2,cols[i%3],-4+i*3,1,-2)); }
  }
  // Bourse : activée -> halo + bulles supplémentaires
  if(zg['Bourse']){ clearLayer(zg['Bourse'],'lvl');
    if(b.bourse>0){ goldHalo(zg['Bourse']);
      for(let i=0;i<3;i++){ const bb=new THREE.Mesh(new THREE.SphereGeometry(0.9+i*0.4,12,12),
        new THREE.MeshStandardMaterial({color:COL.or,transparent:true,opacity:.7,flatShading:true}));
        bb.position.set(2+i*2,9+i,3); bb.userData.bubble=i+3; addLvl(zg['Bourse'],bb); } }
  }
  // Rails : relient Usine -> Entrepôt -> Marché de vente
  if(railsGroup){ scene.remove(railsGroup); railsGroup=null; }
  if(b.rails>0){
    railsGroup=new THREE.Group();
    const seq=['Usine','Entrepôt','Marché de vente'];
    for(let i=0;i<seq.length-1;i++){
      const a=zones.find(z=>z.name===seq[i]).pos, c=zones.find(z=>z.name===seq[i+1]).pos;
      const dx=c.x-a.x, dz=c.z-a.z, len=Math.hypot(dx,dz), ang=Math.atan2(dx,dz);
      for(const off of [-0.6,0.6]){
        const rail=box(0.25,0.18,len, 0x4a4236, (a.x+c.x)/2+Math.cos(ang)*off, 0.2, (a.z+c.z)/2-Math.sin(ang)*off, false);
        rail.rotation.y=ang; railsGroup.add(rail);
      }
      const ties=Math.floor(len/3);
      for(let k=0;k<=ties;k++){ const tx=a.x+dx*k/ties, tz=a.z+dz*k/ties;
        const tie=box(2,0.16,0.4,0x5a4a36,tx,0.18,tz,false); tie.rotation.y=ang; railsGroup.add(tie); }
    }
    scene.add(railsGroup);
  }
  if(typeof updateEnvironmentByStage==='function') updateEnvironmentByStage();
}

/* ---- visibilité des zones : rien n'est "déjà bâti" au départ ---- */
// built? -> on montre la structure ; sinon -> plaque "Pas encore construit / Débloqué par l'accumulation"
const ZONE_VIS = {
  'Usine':              {built:()=>state.buildings.atelier>0,            txt:'Terrain disponible', vacant:true},
  'Marché du travail':  {built:()=>state.buildings.travail>0,            txt:'Place d’embauche — non ouverte'},
  'Entrepôt':           {built:()=>state.buildings.entrepot>0,           txt:'Débloqué par l’accumulation'},
  'Quartier ouvrier':   {built:()=>state.travailleurs>0||state.buildings.quartier>0, txt:'Débloqué par l’accumulation'},
  'Bourse':             {built:()=>state.buildings.bourse>0,             txt:'Débloqué par l’accumulation'},
  'Port · Marché mondial':{built:()=>state.buildings.port>0,             txt:'Débloqué par l’accumulation'},
  'Banque':             {built:()=>state.buildings.banque>0,             txt:'', comptoir:true},
};
function setBaseVisible(group,on){ group.children.forEach(m=>{ if(m.userData&&m.userData.base) m.visible=on; }); }
/* v53 : chaque rafraîchissement de visibilité refait aussi le bâtiment du joueur selon son âge */
function updateZoneVisibility(){
  if(typeof refreshPlayerPlant==='function') refreshPlayerPlant();   // v53
  for(const [name,cfg] of Object.entries(ZONE_VIS)){
    const g=zoneGroups[name]; if(!g) continue;
    const built=cfg.built();
    setBaseVisible(g, built);
    clearLayer(g,'ph');
    if(!built){
      if(cfg.comptoir){ // banque non développée : un simple comptoir / coffre
        const chest=box(4,2,3,COL.brun,0,1,0,false); chest.userData.layer='ph'; g.add(chest);
        const lid=box(4.2,0.5,3.2,COL.or,0,2.2,0,false); lid.userData.layer='ph'; g.add(lid);
        const lab=makeLabel('Comptoir'); lab.scale.set(6,1.4,1); lab.position.set(0,5,0); lab.userData.layer='ph'; g.add(lab);
      } else {
        const plot=new THREE.Mesh(new THREE.CircleGeometry(6,24),
          new THREE.MeshStandardMaterial({color:0x9d9170,transparent:true,opacity:.5}));
        plot.rotation.x=-Math.PI/2; plot.position.y=0.05; plot.userData.layer='ph'; g.add(plot);
        if(cfg.vacant){
          // terrain vide : quelques piquets + panneau planté
          const stakes=[[-5,-4],[5,-4],[-5,4],[5,4],[0,5.4]];
          stakes.forEach(([sx,sz])=>{ const p=box(0.25,1.6,0.25,COL.brun,sx,0.8,sz,false); p.userData.layer='ph'; g.add(p); });
          const post=box(0.3,2.4,0.3,COL.brun,-3,1.2,-1,false); post.userData.layer='ph'; g.add(post);
          const sign=box(4.6,1.8,0.25,COL.papier,-1,2.6,-1,false); sign.userData.layer='ph'; g.add(sign);
        }
        const lab=makeLabel(cfg.txt); lab.scale.set(9,1.5,1); lab.position.set(0,4,0); lab.userData.layer='ph'; g.add(lab);
      }
    }
  }
}

/* ---- Phase 0 : production et vente fondatrices (cycle allégé, sans concurrence/crise) ---- */
function precapitalProduce(){
  const prod = 1*(1+0.5*(state.niveauMachine-1));
  const heuresEff = state.heures*(1-0.55*state.fatigue);
  const Q = Math.max(1, Math.round(state.travailleurs*heuresEff*prod));
  const v = state.travailleurs*state.salaire;        // salaire avancé
  const matieres = Q*MAT_PAR_UNITE;                  // matières (pas d'usure : simples outils)
  state.argent -= (v+matieres);                      // capital avancé
  state.stocks += Q;
  state._pcQ = Q; state._pcRecette = Q*state.prixUnitaire; state._pcCost = v+matieres;
  state._pcV = v; state._pcMat = matieres; state._pcHeures = state.heures; state._pcPrix = state.prixUnitaire;
  state._pcPlus = Math.max(0, Q - v);                // plus-value approx (valeur nouvelle − salaire)
  state.firstProduced = true;
}
function precapitalSell(){
  const Q = state._pcQ||0;
  state.argent += (state._pcRecette||0);             // l'argent revient augmenté
  state.stocks = Math.max(0, state.stocks-Q);
  state.firstSold = true;
}
// Transition : le capital est né -> on bascule en phase circuit
let pendingBirth=false;
function birthOfCapital(){
  gamePhase='circuit';
  if(typeof PlayerDistrict!=='undefined') PlayerDistrict.mark();   // v50 : ton quartier porte tes couleurs dès la fondation
  showChantierBtn(false);
  state.cycle=0;                       // le 1er circuit réel sera le cycle 1 (moteur doux)
  recomputeProduction();
  updateBuildings(); updateZoneVisibility(); updateConsequences(); updateHUD();
  refreshNiveauVille(); renderCircuitBar();
  if(circuitLine) circuitLine.visible=true;   // la ligne du circuit s'allume
  flashTimer=0.9;                             // éclat à l'écran
  ['Banque','Usine','Marché de vente'].forEach(n=>fxPing(n)); // le circuit s'éveille
  afterConcept=()=>{ renderQuest(); renderCircuitBar(); moveTargetMarker(); updateHUD(); updateVilleBadge(); tutorialCoachRefresh(true); };
  Tuto.applyBodyClass();               // bascule phase-precapital → phase-circuit dès la naissance du capital
  showConcept(birthScreen());          // "Le capital est né", sur le compte du joueur (onClose: unlockVoile)
}

/* ---- panneau "Choisir une amélioration" ---- */
let pendingAfterUpgrade=null, foundingMode=false;
function refreshUpgradeChrome(){
  const skip=document.getElementById('upgrade-skip');
  const h2=document.getElementById('upgrade-h2'), sub=document.getElementById('upgrade-sub');
  if(foundingMode){
    document.getElementById('upgrade-stade').textContent='Phase 0 — Argent dormant';
    if(h2) h2.textContent='Plan du chantier';
    if(sub) sub.textContent='Les conditions du capital se construisent sur la carte. Voici ce qu’il reste à faire, et où aller.';
    const checklist=`<div class="ucheck">${sousObjHTML()}</div>`;
    document.getElementById('upgrade-capital').innerHTML=`Argent dormant : <b>${money(state.argent)}</b>${checklist}`;
    skip.textContent='Voir la carte ▸';
    skip.disabled=false;
  } else {
    const niv=state.niveauVille, st=STAGES[niv]||STAGES[0];
    if(h2) h2.textContent='Choisir une amélioration';
    if(sub) sub.textContent='Le profit réalisé peut être réinvesti : accumuler, c’est transformer l’espace social. Choisis une amélioration — ou garde ton capital.';
    document.getElementById('upgrade-stade').textContent=`Développement du capital : niveau ${niv} / 7 — ${st.n}`;
    document.getElementById('upgrade-capital').innerHTML=`Capital disponible : <b>${money(state.argent)}</b>`;
    skip.textContent='Garder mon capital ▸';
    skip.disabled=false;
  }
}
function openUpgrade(after, mode){
  if(mode!=='founding' && !upgradesUnlocked()){
    const fn=after||resumePlay; if(fn) fn();
    return;
  }
  pendingAfterUpgrade=after||null;
  foundingMode = (mode==='founding');
  document.getElementById('upanel-result').style.display='none';
  document.getElementById('upanel-choose').style.display='block';
  refreshUpgradeChrome();
  renderUpgradeDeck();
  document.getElementById('upgrade').classList.add('on');
}
function openFounding(){
  pushLog('Développement','Le plan du chantier sera débloqué plus tard, avec la Grande industrie. Pour l’instant, construis directement sur la carte avec E.','plain');
  resumePlay();
}
// où réaliser chaque action fondatrice (pour le « Plan du chantier »)
const FOUNDING_PLACE = {atelier:'Terrain disponible', outils:'Marché local — moyens', enclosure:'Terres communes',
  embauche0:'Place d’embauche', produire:'Atelier', vendre:'Marché de vente'};
function renderUpgradeDeck(){
  const deck=document.getElementById('upgrade-deck'); deck.innerHTML='';
  if(foundingMode){
    // Plan du chantier : informatif uniquement — on agit sur la carte
    UPGRADES.filter(u=>u.founding).forEach(u=>{
      const cost=upgradeCost(u);
      const done = u.avail ? (!u.avail() && (u.id==='embauche0'?state.travailleurs>0:(u.id==='produire'?state.firstProduced:(u.id==='vendre'?state.firstSold:state.buildings[u.b]>0)))) : (u.once&&state.buildings[u.b]>0);
      const btn=document.createElement('button'); btn.className='ucard'; btn.disabled=true;
      btn.innerHTML=`<div class="uct">${u.t}<span class="ulvl">${done?'✓ fait':'à faire'}</span></div>`+
        `<div class="ucost">${cost>0?money(cost):'gratuit'} &nbsp;·&nbsp; sur la carte : <b>${FOUNDING_PLACE[u.id]||''}</b></div>`+
        `<div class="ueff"><span class="ef">${u.eff}</span><br><span class="cq">${u.cq}</span></div>`;
      deck.appendChild(btn);
    });
    return;
  }
  UPGRADES.filter(u=> !u.founding && upgradeAvailable(u)).forEach(u=>{
    const cost=upgradeCost(u);
    const tag = u.once?'nouveau':'niv. '+(u.b==='usine'&&u.id==='machine'?state.niveauMachine:state.buildings[u.b]);
    const can = state.argent>=cost;
    const btn=document.createElement('button'); btn.className='ucard'; btn.disabled=!can;
    btn.innerHTML=`<div class="uct">${u.t}<span class="ulvl">${tag}</span></div>`+
      `<div class="ucost">${cost>0?money(cost):'gratuit'}${can?'':' · capital insuffisant'}</div>`+
      `<div class="ueff"><span class="ef">${u.eff}</span><br><span class="cq">${u.cq}</span></div>`+
      `<div class="uvis">${u.vis}</div>`;
    btn.onclick=()=>applyUpgrade(u);
    deck.appendChild(btn);
  });
}
function applyUpgrade(u){
  const cost=upgradeCost(u);
  if(state.argent<cost) return;
  state.argent-=cost;
  u.apply(state);
  if(!u.founding) state._investedThisCycle = true;   // construire / élargir = investir
  recomputeProduction();
  if(u.final) pendingBirth=true;        // la vente fondatrice fait naître le capital
  pushLog('Ville',`${u.t}${cost>0?` (−${money(cost)})`:''}. ${u.eff}. ${u.cq}.`,'plain');
  updateBuildings(); updateZoneVisibility(); updateConsequences(); updateHUD();
  if(typeof LivingWorld!=='undefined'){
    const ZMAP={atelier:'Usine',outils:'Usine',usine:'Usine',machine:'Usine',entrepot:'Entrepôt',
      quartier:'Quartier ouvrier',marche:'Marché de vente',travail:'Marché du travail',banque:'Banque',
      rails:'Usine',port:'Port · Marché mondial',bourse:'Bourse'};
    const zn=ZMAP[u.b||u.id];
    if(zn&&zoneGroups[zn]){ animateConstruction(zoneGroups[zn]);
      const ty=u.id==='quartier'?'social':((u.id==='bourse'||u.id==='port')?'crise':'gain');
      const p=zonePos(zn); floatText((u.eff||u.t).replace(/^[+\u2212\-]\s*/,''),{x:p.x,y:8,z:p.z},ty); }
  }
  const monte = u.founding ? null : updateCapitalStage();
  document.getElementById('ures-title').textContent=u.t;
  document.getElementById('ures-effects').innerHTML=`<span class="ef">${u.eff}</span><span class="cq">${u.cq}</span>`;
  let marx=`<b>Tu n’as pas seulement amélioré un bâtiment : tu as modifié le rapport social qu’il organise.</b> ${u.marx}`;
  if(monte) marx+=`<br><br><b>Nouveau stade — ${monte.n}.</b> ${monte.contradiction}`;
  document.getElementById('ures-marx').innerHTML=marx;
  document.getElementById('upanel-choose').style.display='none';
  document.getElementById('upanel-result').style.display='block';
  // M9 — en phase 0 il n'y a pas encore de cycles : construire EST la
  // progression. Sans ce point de sauvegarde, toute la fondation du capital
  // serait perdue au rechargement.
  if(typeof SaveGame!=='undefined') SaveGame.autosave();
}
function closeUpgrade(){
  document.getElementById('upgrade').classList.remove('on');
  const fn=pendingAfterUpgrade; pendingAfterUpgrade=null; if(fn) fn();
}
document.getElementById('upgrade-skip').addEventListener('click',()=>{
  if(foundingMode){ closeUpgrade(); return; }   // "Voir la carte" : regarder le chantier
  closeUpgrade();
});
document.getElementById('upgrade-continue').addEventListener('click',()=>{
  if(pendingBirth){                       // la première vente vient d'avoir lieu
    pendingBirth=false; foundingMode=false;
    document.getElementById('upgrade').classList.remove('on');
    birthOfCapital();
    return;
  }
  if(foundingMode){                       // en phase 0 : revenir bâtir la suite
    document.getElementById('upanel-result').style.display='none';
    document.getElementById('upanel-choose').style.display='block';
    refreshUpgradeChrome(); renderUpgradeDeck();
  } else closeUpgrade();
});

/* ===================================================================
   Cartes de décision (à l'usine)
   =================================================================== */
const DECK = [
  {id:'jour', t:'Allonger la journée',
   ups:['+ plus-value'], dns:['+ fatigue','+ colère'], cost:'+1 h de travail',
   can:()=>state.heures<state.limiteJournee,
   fx:[['production','+'],['fatigue +8 %','-'],['colère +5 %','-']],
   chain:['Tu allonges la journée de travail','→ le surtravail augmente','→ plus de plus-value extraite','→ mais la fatigue et la colère montent'],
   marx:'Tu augmentes la <b>plus-value absolue</b> : en allongeant la journée sans payer plus, tu arraches davantage de surtravail à la même force de travail.',
   play:()=>{ state.heures=Math.min(state.limiteJournee,state.heures+1);
     pushLog(productionPlaceLabel(),'La journée s’allonge d’une heure. On arrache plus de surtravail — mais les corps s’usent.','social'); }},
  {id:'jour_down', t:'Réduire la journée',
   ups:['− fatigue','− colère'], dns:['− production','− plus-value absolue'], cost:'−1 h de travail',
   can:()=>state.heures>8,
   fx:[['fatigue −10 %','+'],['colère −5 %','+'],['production','-']],
   chain:['Tu réduis la journée de travail','→ les corps récupèrent','→ la colère retombe','→ mais le temps de surtravail diminue','→ la plus-value absolue baisse'],
   marx:'Tu limites l’extraction de <b>plus-value absolue</b> : moins d’heures travaillées, c’est moins de surtravail, mais aussi une force de travail moins épuisée.',
   play:()=>{ state.heures=Math.max(8,state.heures-1); state.fatigue=clamp(state.fatigue-0.10);
     state.colere=clamp(state.colere-0.05); state.sante=clamp(state.sante+0.04);
     pushLog(productionPlaceLabel(),`Journée ramenée à ${state.heures} h. La fatigue baisse, mais le surtravail disponible diminue.`,'social'); }},
  {id:'sal', t:'Augmenter les salaires',
   ups:['− colère','+ demande ouvrière'], dns:['− profit'], cost:'+1 £ / ouvrier',
   can:()=>true,
   fx:[['colère −7 %','+'],['demande ouvrière','+'],['profit','-']],
   chain:['Tu augmentes les salaires','→ la colère ouvrière retombe','→ la demande solvable des ouvriers monte','→ mais le capital variable coûte plus cher','→ la part qui revient au capital diminue'],
   marx:'Tu rends une part plus grande de la valeur au travail : la paix sociale et la demande ouvrière se paient d’une <b>plus-value</b> plus faible.',
   play:()=>{ state.salaire+=1; state.colere=clamp(state.colere-0.07);
     pushLog(productionPlaceLabel(),`Salaire porté à ${state.salaire} £. La colère retombe et la demande ouvrière se renforce, mais la part qui revient au capital diminue.`); }},
  {id:'sal_down', t:'Baisser les salaires',
   ups:['+ profit potentiel','+ taux d’exploitation'], dns:['+ colère','− demande ouvrière'], cost:'−1 £ / ouvrier',
   can:()=>state.salaire>3,
   fx:[['profit potentiel','+'],['taux d’exploitation','+'],['colère +9 %','-'],['demande ouvrière','-']],
   chain:['Tu baisses les salaires','→ le capital variable diminue','→ la plus-value potentielle augmente','→ mais la colère ouvrière monte','→ la demande solvable se fragilise'],
   marx:'Tu abaisses la valeur payée à la force de travail : la part du <b>travail nécessaire</b> diminue et le taux d’exploitation monte, mais la reproduction sociale et la paix ouvrière se fragilisent.',
   play:()=>{ state.salaire=Math.max(3,state.salaire-1); state.colere=clamp(state.colere+0.09);
     state.conscience=clamp(state.conscience+0.03);
     pushLog(productionPlaceLabel(),`Salaire abaissé à ${state.salaire} £. Le capital variable diminue et le taux d’exploitation monte, mais la colère ouvrière monte et la demande se fragilise.`,'social'); }},
  {id:'hire', t:'Embaucher',
   ups:['+ production'], dns:['+ masse salariale'], cost:'+1 ouvrier',
   can:()=>state.travailleurs<state.populationActive,
   fx:[['production','+'],['masse salariale','-']],
   chain:['Tu embauches un ouvrier','→ plus de travail vivant','→ plus de valeur créée','→ mais plus de salaires à avancer'],
   marx:'Tu ajoutes du <b>travail vivant</b> — la seule source de valeur nouvelle. Plus de bras, donc plus de plus-value possible, mais aussi plus de capital variable à avancer.',
   play:()=>{ state.travailleurs=Math.min(state.populationActive,state.travailleurs+1); state._investedThisCycle=true; recomputeProduction(); updateCapitalStage();
     pushLog(productionPlaceLabel(),`Un ouvrier de plus (${state.travailleurs}). Plus de travail vivant — donc plus de valeur, et plus de salaires à avancer.`); }},
  {id:'fire', t:'Licencier',
   ups:['− masse salariale'], dns:['+ chômage','+ colère'], cost:'−1 ouvrier',
   can:()=>state.travailleurs>1,
   fx:[['masse salariale','+'],['chômage','-'],['colère +6 %','-']],
   chain:['Tu licencies un ouvrier','→ la masse salariale baisse','→ l’armée de réserve grossit','→ le chômage et la colère augmentent'],
   marx:'Tu grossis l’<b>armée industrielle de réserve</b> : ces sans-emploi font pression à la baisse sur les salaires de ceux qui restent.',
   play:()=>{ state.travailleurs=Math.max(1,state.travailleurs-1); state.colere=clamp(state.colere+0.06); recomputeProduction();
     pushLog(productionPlaceLabel(),`Un ouvrier jeté à la rue (${state.travailleurs} restants). L’armée de réserve grossit ; la colère monte.`,'social'); }},
  {id:'mach', t:'Acheter une machine à crédit', whapAction:'Tu as mécanisé en t’endettant.',
   ups:['+ productivité'], dns:['+ dette (+200 £)','+ chômage'], cost:'⚠ Dette +200 £ (achat à crédit)',
   can:()=>state.cycle>2,
   fx:[['productivité','+'],['dette +200 £','-'],['chômage','-']],
   chain:['Tu achètes une machine à crédit','→ +200 £ de dette','→ la productivité augmente','→ le besoin de travail vivant diminue','→ le chômage augmente','→ pression à la baisse sur les salaires'],
   marx:'Tu alourdis le <b>capital constant</b>, et à crédit : la composition organique monte, la machine remplace les bras — mais la dette ponctionnera le profit à venir.',
   play:()=>{ state.niveauMachine++; state.dette+=200; state._cycleMachine=(state._cycleMachine||0)+1; state._investedThisCycle=true; updateCapitalStage();
     pushLog(productionPlaceLabel(),`Machine installée à crédit (niveau ${state.niveauMachine}, +200 £ de dette). Le capital constant s’alourdit ; il faudra moins de bras, et la dette se rembourse avec intérêts.`,'warn'); }},
  {id:'surv', t:'Intensifier la surveillance', can:()=>state.niveauVille>=2,
   ups:['+ productivité (discipline)'], dns:['+ peur du chômage','+ colère'], cost:'discipline accrue',
   fx:[['productivité','+'],['peur du chômage','-'],['colère','-']],
   chain:['Tu intensifies la surveillance','→ le rythme se discipline','→ un peu plus de productivité','→ mais la peur et la colère montent'],
   marx:'La discipline d’atelier extrait davantage de travail dans le même temps — mais elle aiguise l’antagonisme entre capital et travail.',
   play:()=>{ state.disciplineBonus=Math.min(1.12,(state.disciplineBonus||1)+0.03); state.peurChomage=clamp(state.peurChomage+0.08); state.colere=clamp(state.colere+0.05); state.conscience=clamp(state.conscience+0.04);
     pushLog(productionPlaceLabel(),'Surveillance renforcée : le rythme se discipline, mais la colère couve.','social'); }},
  {id:'secu', t:'Améliorer la sécurité', can:()=>state.niveauVille>=2 && state.argent>=50,
   ups:['− accidents','− colère','+ santé'], dns:['− trésorerie'], cost:'−50 £',
   fx:[['accidents','+'],['colère','+'],['santé','+'],['trésorerie −50 £','-']],
   chain:['Tu investis dans la sécurité','→ moins d’accidents','→ la colère retombe','→ mais la trésorerie baisse'],
   marx:'Préserver la force de travail coûte aujourd’hui, mais entretient la source même de la valeur.',
   play:()=>{ state.argent-=50; state.securiteNiveau=(state.securiteNiveau||0)+1; state.sante=clamp(state.sante+0.10); state.colere=clamp(state.colere-0.08);
     if(state.revendication==='securite') state.revendication=null;
     pushLog(productionPlaceLabel(),'Sécurité améliorée (−50 £) : moins d’accidents, colère apaisée.'); }},
  {id:'prime', t:'Promettre une prime', can:()=>state.niveauVille>=2 && state.argent>=30,
   ups:['− colère (temporaire)'], dns:['− trésorerie','colère ↑ plus tard si non renouvelée'], cost:'−30 £',
   fx:[['colère','+'],['trésorerie −30 £','-']],
   chain:['Tu promets une prime','→ la colère retombe maintenant','→ mais la promesse crée une attente','→ non renouvelée, la colère remonte'],
   marx:'La prime achète une paix sociale provisoire : la concession différée ne supprime pas l’antagonisme, elle le reporte.',
   play:()=>{ state.argent-=30; state.colere=clamp(state.colere-0.12); state._primeActive=2;
     pushLog(productionPlaceLabel(),'Prime promise (−30 £) : la colère retombe — pour un temps.','social'); }},
];
// --- décisions à la banque : crédit volontaire, jamais automatique ---
function emprunter(montant){
  const place=Math.max(0, state.plafondCredit - state.dette);
  const e=Math.min(montant, place);
  if(e<=0) return;
  state.dette+=e; state.argent+=e; state._cycleCredit+=e;
  pushLog('Banque',`Emprunt de ${money(e)}. Dette : ${money(state.dette)} (taux ${pct(state.tauxInteret)}). Le crédit avance du capital — mais il se rembourse avec intérêts.`,'warn');
}
function rembourser(montant){
  const m=Math.min(montant, state.dette, Math.max(0,state.argent));
  if(m<=0) return;
  state.dette-=m; state.argent-=m; state._cycleRepay+=m;
  rememberEvent(state,'bankers','remboursement','remboursement');
  pushLog('Banque',`Remboursement de ${money(m)}. Dette : ${money(state.dette)}. Les intérêts futurs diminuent.`);
}
const BANK_DECK = [
  {id:'emp50', t:'Emprunter 50 £', ups:['+ trésorerie'], dns:['+ dette','+ intérêts futurs'], cost:'+50 £ de dette',
   can:()=>state.plafondCredit-state.dette>=50,
   fx:[['trésorerie +50 £','+'],['dette +50 £','-']],
   chain:['Tu empruntes 50 £','→ du capital frais à avancer','→ mais une dette à rembourser','→ avec intérêts'],
   marx:'Le crédit avance du capital que tu n’as pas encore : il accélère le circuit, mais le capital financier prélèvera sa part.',
   play:()=>emprunter(50)},
  {id:'emp100', t:'Emprunter 100 £', ups:['+ trésorerie'], dns:['+ dette','+ intérêts futurs'], cost:'+100 £ de dette',
   can:()=>state.plafondCredit-state.dette>=100,
   fx:[['trésorerie +100 £','+'],['dette +100 £','-']],
   chain:['Tu empruntes 100 £','→ plus de capital à avancer','→ mais une dette plus lourde'],
   marx:'Emprunter, c’est mobiliser le capital d’autrui : utile pour investir, mais la charge d’intérêt pèse sur le profit futur.',
   play:()=>emprunter(100)},
  {id:'emp200', t:'Emprunter 200 £', ups:['+ trésorerie'], dns:['+ dette','+ intérêts futurs'], cost:'+200 £ de dette',
   can:()=>state.plafondCredit-state.dette>=200,
   fx:[['trésorerie +200 £','+'],['dette +200 £','-']],
   chain:['Tu empruntes 200 £','→ de quoi mécaniser','→ mais un service de la dette élevé'],
   marx:'Le crédit permet d’investir au-delà de ses moyens — au prix d’une dépendance au capital financier.',
   play:()=>emprunter(200)},
  {id:'remb50', t:'Rembourser 50 £', ups:['− dette','− intérêts futurs'], dns:['− trésorerie'], cost:'−50 £',
   can:()=>state.dette>0 && state.argent>=50,
   fx:[['dette −50 £','+'],['trésorerie −50 £','-']],
   chain:['Tu rembourses 50 £','→ la dette diminue','→ les intérêts futurs baissent','→ mais ta trésorerie baisse maintenant'],
   marx:'Rembourser, c’est rendre au capital financier sa part : moins d’intérêts demain, mais moins de capital disponible aujourd’hui.',
   play:()=>rembourser(50)},
];
let activeDeck='usine';
function deckFor(which){ return which==='bank'?BANK_DECK:DECK; }
function openCards(which){
  activeDeck = which || 'usine';
  const bank = activeDeck==='bank';
  document.querySelector('#cards .panel h3').textContent = bank ? 'À la banque — le crédit' : 'À l’usine — le procès de production';
  document.querySelector('#cards .panel .sub').textContent = bank
    ? 'Le crédit est une décision volontaire : il avance du capital, mais se rembourse avec intérêts. Rien n’est emprunté automatiquement.'
    : 'C’est ici que le capital se valorise. Chaque décision arrache plus de valeur — et produit ses propres contradictions.';
  document.getElementById('cards-note').textContent = bank
    ? 'Emprunte ou rembourse si tu le souhaites, puis reprends la route.'
    : 'Joue autant de cartes que tu veux, puis reprends la route vers l’entrepôt (M′).';
  renderCards();
  closeWhap();
  document.getElementById('cards').classList.add('on');
}
function renderCards(){
  const bank = activeDeck==='bank';
  document.getElementById('cards-now').innerHTML = bank
    ? `Argent <b>${money(state.argent)}</b> · Dette <b>${money(state.dette)}</b> · Taux <b>${pct(state.tauxInteret)}</b> · Plafond <b>${money(state.plafondCredit||0)}</b>`
    : `Journée <b>${state.heures} h</b> · Salaire <b>${state.salaire} £</b> · Ouvriers <b>${state.travailleurs}</b> · Machines <b>niv. ${state.niveauMachine}</b> · Argent <b>${money(state.argent)}</b>`;
  const deck=document.getElementById('cards-deck'); deck.innerHTML='';
  deckFor(activeDeck).forEach(c=>{
    const b=document.createElement('button'); b.className='card'; b.disabled=!c.can();
    b.innerHTML=`<div class="ct">${c.t}</div><div class="eff">`+
      c.ups.map(u=>`<span><span class="up">▲</span> ${u.replace(/^[+\-−]\s*/,'')}</span>`).join('')+
      c.dns.map(d=>`<span><span class="dn">▼</span> ${d.replace(/^[+\-−]\s*/,'')}</span>`).join('')+
      `</div><div class="cost${c.id==='mach'?' debt':''}">${c.cost}</div>`;
    b.onclick=()=>{ c.play(); renderCards(); updateHUD(); updateConsequences();
      showWhap({action:c.whapAction||`Tu as joué : <b>${c.t.toLowerCase()}</b>.`, fx:c.fx, chain:c.chain, marx:c.marx}); };
    deck.appendChild(b);
  });
}
document.getElementById('cards-done').addEventListener('click',()=>{
  document.getElementById('cards').classList.remove('on');
  if(currentZone && currentZone.name!=='Usine') showLevers(false);
});

/* ===================================================================
   Pédagogie : panneau "Ce qui vient de se passer", mode guidé, journal
   =================================================================== */
// niveau de dévoilement : 0 = geste simple (cycle 1) · 1 = plus-value révélée
function revealLevel(){ return voileUnlocked ? 1 : 0; }

// Pour chaque étape du circuit : le lieu, ce qu'on y fait, son sens,
// et une lecture courte (simple au cycle 1, marxienne ensuite).
const ZONE_GUIDE = {
  'Banque':{ lieu:'La banque avance le capital de départ. C’est le point de départ et de retour du circuit.',
    todo:'Appuie sur E pour avancer l’argent (A). Tu peux emprunter, mais la dette se rembourse avec intérêts.',
    sens:'A — l’argent est avancé pour être mis en mouvement, pas pour dormir.',
    whap:{a:'Tu as avancé le capital de départ (A).', fx:[['capital prêt à circuler','+']],
      m0:'C’est le point de départ : ton argent va circuler pour revenir augmenté.',
      m1:'A — l’argent-capital est avancé dans le seul but de revenir grossi : A → A′.'}},
  'Marché des moyens':{ lieu:'Le marché des moyens de production : machines et matières premières.',
    todo:'Appuie sur E pour acheter le capital constant (M) nécessaire à la production.',
    sens:'M — sans matières ni machines, pas de production possible.',
    whap:{a:'Tu as acheté des moyens de production (M).', fx:[['capital constant engagé','-']],
      m0:'Tu transformes une partie de ton argent en machines et matières.',
      m1:'M — l’argent se change en <b>capital constant</b> (c) : il transmet sa valeur au produit sans en créer de nouvelle.'}},
  'Marché du travail':{ lieu:'Le marché du travail : on y embauche la force de travail.',
    todo:'Appuie sur E pour engager la force de travail (Ft) : les ouvriers qui produiront.',
    sens:'Ft — la force de travail est une marchandise particulière : elle crée de la valeur.',
    whap:{a:'Tu as engagé la force de travail (Ft).', fx:[['capital variable engagé','-']],
      m0:'Tu paies des ouvriers pour qu’ils travaillent pour toi.',
      m1:'Ft — l’argent se change en <b>capital variable</b> (v). C’est la seule marchandise qui produit plus de valeur qu’elle ne coûte.'}},
  'Usine':{ lieu:'L’usine : le procès de production. C’est ici que le capital se valorise.',
    todo:'Appuie sur E pour ouvrir les cartes de décision : règle la journée, les salaires, les machines, les effectifs.',
    sens:'P — c’est ici, et nulle part ailleurs, que la valeur nouvelle est créée.',
    whap:null},
  'Entrepôt':{ lieu:'L’entrepôt : les marchandises produites s’y entassent avant d’être vendues.',
    todo:'Appuie sur E pour constater le stock produit (M′).',
    sens:'M′ — la valeur est désormais incorporée dans des marchandises, mais pas encore réalisée.',
    whap:{a:'Tu as produit des marchandises (M′).', fx:[['stock à vendre','+']],
      m0:'Le travail a transformé les matières en marchandises prêtes à vendre.',
      m1:'M′ — les marchandises contiennent c + v + plus-value, mais cette valeur n’est encore que potentielle : il faut la vendre.'}},
  'Marché de vente':{ lieu:'Le marché de vente : c’est ici que les marchandises se changent en argent.',
    todo:'Appuie sur E pour vendre (M′ → A′) et boucler le cycle. Le bilan s’affichera.',
    sens:'A′ — si tout s’est bien passé, l’argent revient augmenté. La boucle est complète.',
    whap:null},
};

let whapTimer=null;
function showWhap({action,fx,chain,marx}){
  const w=document.getElementById('whap');
  document.getElementById('whap-action').innerHTML=action||'—';
  // effets de jeu
  const fxe=document.getElementById('whap-effect'); fxe.innerHTML='';
  (fx||[]).forEach(([label,dir])=>{
    const s=document.createElement('span');
    s.className = dir==='+'?'up':(dir==='-'?'dn':'');
    s.textContent=(dir==='+'?'▲ ':(dir==='-'?'▼ ':''))+label;
    fxe.appendChild(s);
  });
  // enchaînement causal
  const chBlk=document.getElementById('whap-chainblk'), ch=document.getElementById('whap-chain');
  if(chain&&chain.length>1){ ch.innerHTML=chain.map((l,i)=>`<span class="lk${i===0?' head':''}">${l}</span>`).join('');
    chBlk.style.display='block'; }
  else chBlk.style.display='none';
  // lecture marxienne
  document.getElementById('whap-marx').innerHTML=marx||'—';
  w.classList.add('on'); w.classList.remove('compact');     // déplié d'abord
  clearTimeout(whapTimer);
  whapTimer=setTimeout(()=>w.classList.add('compact'), 6500); // puis se replie en version compacte
}
function closeWhap(){ const w=document.getElementById('whap'); w.classList.remove('on','compact'); clearTimeout(whapTimer); }
document.getElementById('whap-x').addEventListener('click',closeWhap);
document.getElementById('whap-expand').addEventListener('click',()=>{
  document.getElementById('whap').classList.remove('compact'); clearTimeout(whapTimer);
});

// journal complet — uniquement les événements réellement vécus, pas les anciennes consignes génériques
let journalEntries=[];
function isJournalWorthy(title,text,type){
  const t=String(title||''), body=String(text||'');
  if(t==='Affichage' || t==='Développement') return false;
  if(body.includes('Le circuit ne passe pas encore') || body.includes('Ce lieu sera utile plus tard')) return false;
  if(body.includes('Pas d’intervention directe') || body.includes('Va d’abord à')) return false;
  if(body.includes('capital insuffisant') || body.includes('Capital insuffisant')) return false;
  return true;
}
function renderJournalModal(){
  const b=document.getElementById('journal-body');
  if(!journalEntries.length){
    b.innerHTML='<p><b>Journal historique —</b> Aucun événement vécu pour le moment. Les actions de la partie apparaîtront ici au fil du jeu.</p>';
    return;
  }
  b.innerHTML = journalEntries.map(e=>`<p${e.col?` style="color:${e.col}"`:''}>${e.html}</p>`).join('');
}
document.getElementById('log-open').addEventListener('click',()=>{
  renderJournalModal(); document.getElementById('journal').classList.add('on');
});
document.getElementById('chantier-btn').addEventListener('click',openFounding);
function showChantierBtn(on){
  const b=document.getElementById('chantier-btn');
  if(b) b.style.display='none'; // v35 : retiré du début de partie ; reviendra plus tard avec la Grande industrie
}
document.getElementById('journal-close').addEventListener('click',()=>{
  document.getElementById('journal').classList.remove('on');
});

// mode guidé
let guideMode=true, pendingStep=null;
// v47 : #guide-toggle n'existe plus dans le HTML (vestige d'une ancienne option) — garde inoffensive conservée.
const guideToggle=document.getElementById('guide-toggle');
if(guideToggle) guideToggle.addEventListener('change',e=>{ guideMode=e.target.checked; });
function showGuide(zone, proceed){
  const g=ZONE_GUIDE[zone.name]; if(!g){ proceed(); return; }
  const c=CIRCUIT[step];
  document.getElementById('guide-sym').textContent=c?c.sym:'';
  document.getElementById('guide-place').textContent=zone.name;
  document.getElementById('guide-lieu').textContent=g.lieu;
  document.getElementById('guide-todo').textContent=g.todo;
  document.getElementById('guide-sens').textContent=g.sens;
  pendingStep=proceed;
  document.getElementById('guide').classList.add('on');
}
document.getElementById('guide-ok').addEventListener('click',()=>{
  document.getElementById('guide').classList.remove('on');
  const fn=pendingStep; pendingStep=null; if(fn) fn();
});
// lecture courte d'une étape (simple au cycle 1, marxienne après)
function whapForZone(zone){
  const g=ZONE_GUIDE[zone.name]; if(!g||!g.whap) return;
  const w=g.whap;
  showWhap({action:w.a, fx:w.fx, chain:null, marx: revealLevel()===0 ? w.m0 : w.m1});
}

/* ===================================================================
   Tutoriel progressif : le guide se retire au fil des cycles
   Cycle 1 : à chaque étape · Cycle 2 : usine + vente · Cycle 3+ : jamais
   (les concepts nouveaux passent alors par l'écran de concept)
   =================================================================== */
function displayCycle(){ return gamePhase==='precapital' ? 0 : state.cycle+1; }
function stepGuideZones(){
  const dc=displayCycle();
  if(dc<=1) return null;                              // 1er circuit réel : tous les lieux
  if(dc===2) return new Set(['Usine','Marché de vente']);
  return new Set();                                   // ensuite : plus de pause d'étape
}
function shouldPauseAt(zone){ return false; }

// Lieux verrouillés pendant le cycle 1 (tutoriel circuit pur)
const LOCKED_C1=new Set(['Quartier ouvrier','État · Tribunal','Mines · Champs','Port · Marché mondial','Bourse']);
function zoneLocked(name){ return state.cycle===0 && LOCKED_C1.has(name); }

/* ===================================================================
   Tutoriel v47 — parcours explicite en 6 phases
   Le tutoriel ne décrit plus le jeu de l'extérieur : chaque phase est
   un état dérivé de la partie elle-même, et règle la densité de
   l'interface (classe CSS tuto-pN sur <body>).

     0  Entrée sensible        : le joueur n'a pas encore bougé. Presque pas de texte.
     1  Circuit par le corps   : phase 'precapital' — construire les conditions en se déplaçant.
     2  Premier cycle dirigé   : phase 'circuit' — boucler A→M→Ft→P→M′→A′, chaque étape montre ses variables.
     3  Première contradiction : 1re-2e période sociale — un écran montre la contradiction VÉCUE (cf. maybeShowFirstContradiction).
     4  Jeu semi-libre         : formation sociale, 3 interventions/période, coach encore présent.
     5  Lecture systémique     : le tutoriel s'efface — restent jauges, objectif, contradictions, bilans, journal.
   =================================================================== */
const Tuto={
  phase(){
    if(typeof gameMode!=='undefined' && gameMode==='commune') return 5;
    if(gamePhase==='precapital') return (TutorialCoach.hasMoved||state.buildings.atelier>0)?1:0;
    if(gamePhase==='circuit') return 2;
    if(typeof gameMode!=='undefined' && gameMode==='socialFormation'){
      if((state.cycle||0)<=2 && !state._contradictionShown) return 3;
      if((state.cycle||0)<=4) return 4;
      return 5;
    }
    return 5;
  },
  _last:-1,
  applyBodyClass(){
    const ph=this.phase();
    document.body.classList.toggle('phase-precapital', gamePhase==='precapital');
    document.body.classList.toggle('phase-circuit',    gamePhase!=='precapital');
    if(ph===this._last) return;
    document.body.classList.remove('tuto-p0','tuto-p1','tuto-p2','tuto-p3','tuto-p4','tuto-p5');
    document.body.classList.add('tuto-p'+ph);
    this._last=ph;
  }
};
const TutorialCoach={
  active:false,
  minimized:false,
  lastKey:'',
  pulseEl:null,
  tourKey:'',
  tourIndex:0,
  startPos:null,
  hasMoved:false,
  zoneActionOpen(){ const z=document.getElementById('zoneact'); return !!(z&&z.classList.contains('on')); },
  setResolveHint(on){
    const h=document.getElementById('resolve-hint');
    if(!h) return;
    if(!on){ h.classList.remove('on'); return; }
    const rb=document.getElementById('f-cyclebox')||document.getElementById('f-resolve');
    if(!rb){ h.classList.remove('on'); return; }
    const r=rb.getBoundingClientRect();
    if(!r || r.width<=0 || r.height<=0){ h.classList.remove('on'); return; }
    h.style.top=Math.round(r.top + r.height/2 - 28)+'px';
    h.style.left=Math.max(8,Math.round(r.left - 232))+'px';
    h.classList.add('on');
  },
  resetMovement(){
    this.hasMoved=false;
    try{ this.startPos = Vehicle && Vehicle.pos ? Vehicle.pos.clone() : null; }catch(e){ this.startPos=null; }
  },
  updateMovement(){
    if(this.hasMoved || !this.startPos || !Vehicle || !Vehicle.pos) return;
    const dx=Vehicle.pos.x-this.startPos.x, dz=Vehicle.pos.z-this.startPos.z;
    if(Math.hypot(dx,dz)>5) this.hasMoved=true;
  },
  clearFocus(){
    const f=document.getElementById('tuto-focus'); if(f) f.classList.remove('on');
  },
  setFocus(item,progressText=''){
    const f=document.getElementById('tuto-focus'); const lab=document.getElementById('tuto-focus-label');
    if(!f || !item || !item.sel) { this.clearFocus(); return; }
    const el=document.querySelector(item.sel);
    if(!el){ this.clearFocus(); return; }
    const r=el.getBoundingClientRect();
    if(!r || r.width<=0 || r.height<=0){ this.clearFocus(); return; }
    f.style.left=Math.max(4,Math.round(r.left-8))+'px';
    f.style.top=Math.max(4,Math.round(r.top-8))+'px';
    f.style.width=Math.round(r.width+16)+'px';
    f.style.height=Math.round(r.height+16)+'px';
    if(lab) lab.textContent=(progressText?progressText+' · ':'')+(item.label||'Repère');
    f.classList.add('on');
  },
  clearPulse(){
    if(this.pulseEl){ this.pulseEl.classList.remove('coach-pulse'); this.pulseEl=null; }
    this.setResolveHint(false); this.clearFocus();
  },
  setPulse(id){
    if(!id) return;
    const el=document.getElementById(id);
    if(el){ el.classList.add('coach-pulse'); this.pulseEl=el; }
    if(id==='f-resolve') this.setResolveHint(true);
  },
  hide(){
    this.clearPulse();
    document.body.classList.remove('tutorial-emphasis');
    const el=document.getElementById('tutorial-coach'); if(el){ el.classList.add('hidden'); el.classList.remove('zoneact-help'); }
  },
  applyTour(step){
    const nav=document.getElementById('coach-nav'); const prog=document.getElementById('coach-prog');
    const prev=document.getElementById('coach-prev'); const next=document.getElementById('coach-next');
    const hasTour=step.tour && step.tour.length;
    if(!hasTour){ if(nav) nav.style.display='none'; this.setFocus(null); return step; }
    if(this.tourKey!==step.key){ this.tourKey=step.key; this.tourIndex=0; }
    this.tourIndex=Math.max(0,Math.min(this.tourIndex,step.tour.length-1));
    const item=step.tour[this.tourIndex];
    if(nav){ nav.style.display='flex'; }
    if(prog) prog.textContent=(this.tourIndex+1)+' / '+step.tour.length;
    if(prev) prev.disabled=this.tourIndex<=0;
    if(next) next.disabled=this.tourIndex>=step.tour.length-1;
    this.setFocus(item,(this.tourIndex+1)+'/'+step.tour.length);
    return {
      ...step,
      title:item.title||step.title,
      body:item.body||step.body,
      keys:item.keys||step.keys,
      pulse:item.pulse||step.pulse||null
    };
  },
  render(force=false){
    const el=document.getElementById('tutorial-coach'); if(!el) return;
    const zoneModal=this.zoneActionOpen();
    if(!this.active || gameOver || (anyModalOpen()&&!zoneModal)){ this.hide(); return; }
    el.classList.toggle('zoneact-help', zoneModal);
    let step=tutorialCoachStep();
    if(!step){ this.hide(); return; }
    step=this.applyTour(step);
    document.body.classList.toggle('tutorial-emphasis', !!step.emphasis);
    this.clearPulse();
    this.setPulse(step.pulse||null);
    el.classList.toggle('min',this.minimized);
    el.classList.remove('hidden');
    const k=document.getElementById('coach-k'); if(k) k.textContent=step.kicker||'Tutoriel';
    const t=document.getElementById('coach-title'); if(t) t.innerHTML=step.title||'—';
    const b=document.getElementById('coach-body'); if(b) b.innerHTML=step.body||'';
    const keys=document.getElementById('coach-keys');
    if(keys) keys.innerHTML=(step.keys||[]).map(x=>`<span>${x}</span>`).join('');
    const rc=document.getElementById('coach-recap');
    if(rc){
      const r=step.recap;
      if(r){ rc.innerHTML=`<div class="rl">Tu viens de</div><div class="rt">${r.t}</div>${r.n?`<div class="rn">${r.n}</div>`:''}<div class="rm">${r.m}</div>`; rc.hidden=false; }
      else { rc.hidden=true; rc.innerHTML=''; }
    }
  }
};
function tutorialCoachRefresh(force=false){
  try{ Tuto.applyBodyClass(); TutorialCoach.render(force); }catch(e){}
}
/* Le carnet de la fondation. Une seule surface, deux temps : la consigne (où
   aller, quoi faire, pourquoi) et, sous un filet, ce qu'on vient de faire —
   avec les chiffres. Le sur-titre dit l'acte : c'est une histoire en trois. */
const FONDATION_TXT={
  atelier:  {far:['Va au terrain vide, au sud de la grand-rue.','Un atelier, c’est de l’argent qui cesse de dormir pour se fixer dans des murs. Il t’en coûtera 150 £ sur tes 400.'],
             near:['Construis l’atelier.','Appuie sur <b>E</b>. 150 £ deviennent un bâtiment : ils ne reviendront pas comme argent, mais comme lieu de production.']},
  outils:   {far:['Va au marché local, au nord.','Des murs vides ne transforment rien. Il faut ce sur quoi le travail va porter — les matières — et ce avec quoi il va porter — les outils.'],
             near:['Achète outils et matières.','Appuie sur <b>E</b>. 100 £. Les moyens de production transmettent leur valeur au produit ; ils n’en créent aucune.']},
  enclosure:{far:['Va aux terres communes, tout à l’ouest.','Personne ici ne vend sa force de travail : les paysans ont leurs champs, leur bétail, les communs. Tant qu’ils peuvent vivre sans toi, ton atelier restera vide.'],
             near:['Regarde ce qui se passe.','Appuie sur <b>E</b>. Ce n’est pas toi qui clôtures — c’est la loi et le propriétaire. Mais sans cela, personne ne viendrait vendre ses bras.']},
  embauche0:{far:['Va à la place d’embauche.','Ils ont leur personne, et rien d’autre. Toi, tu as l’atelier. La rencontre peut avoir lieu.'],
             near:['Embauche le premier ouvrier.','Appuie sur <b>E</b>. Tu achètes sa force de travail : 5 £ par cycle, pour dix heures de travail par jour.']},
  produire: {far:['Retourne à l’atelier.','Tout est réuni : les murs, les outils, les matières, un ouvrier. Il reste à les faire fonctionner ensemble.'],
             near:['Lance la production.','Appuie sur <b>E</b>. Tu avances le salaire et les matières ; dix heures de travail changent les matières en marchandises.']},
  vendre:   {far:['Va au marché de vente, à l’est.','La valeur est dans les caisses, pas dans ton coffre. Il faut la réaliser — la changer en argent.'],
             near:['Vends.','Appuie sur <b>E</b>. Si le marché prend tes marchandises à leur valeur, l’argent revient. On saura alors s’il revient augmenté.']},
};
function foundingCoachStep(){
  TutorialCoach.updateMovement();
  const tz=precapitalTargetZone();
  const acte=fondationActe();
  const base={kicker:`Acte ${acte.acte} · ${acte.nom}`, keys:['Z / ↑ avancer','Q / D tourner','E agir'], recap:fondaRecap};
  if(!tz) return {...base,key:'founding-sell',title:'Vends la première marchandise.',body:'Va au marché de vente, à l’est.'};
  const u=precapitalAction(tz);
  const near = currentZone && currentZone.name===tz;

  if(!TutorialCoach.hasMoved && state.buildings.atelier===0){
    return {...base,
      key:'move-first',
      title:'Prends le chariot.',
      body:'Avance, tourne, recule. La balise rouge, au sud de la grand-rue, marque un terrain vide : c’est là que tout commence.<div class="movegrid"><span class="ghost"></span><b>Z</b><span class="ghost"></span><b>Q</b><b>S</b><b>D</b></div>',
      keys:['Z ou ↑ : avancer','S ou ↓ : reculer','Q/D ou ←/→ : tourner','R : replacer']
    };
  }
  const tx=(u&&FONDATION_TXT[u.id])||{far:['Rejoins la balise rouge.','Le prochain lieu de la fondation.'],near:['Agis ici.','Appuie sur <b>E</b>.']};
  const [ti,bo]=near?tx.near:tx.far;
  return {...base,
    key:'founding-'+(u?u.id:tz)+(near?'-near':'-far'),
    title:ti,
    body:bo+(near?'':`<br><b>Où :</b> ${precapitalZoneLabel(tz)}.`),
    keys:near?['E : agir maintenant']:['Suis la balise rouge','E une fois sur place']
  };
}
/* v47 : une seule phrase courte par lettre — la compréhension passe par le trajet, pas par le texte */
const CIRCUIT_COACH={
  A:['A — L’argent avancé','Cette fois tu sais ce qu’il va faire. Le comptoir est le point de départ — et le point de retour.'],
  M:['M — Les moyens de production','Ce que le travail a consommé doit être racheté : matières, usure des outils.'],
  Ft:['Ft — La force de travail','L’ouvrier est là ; sa journée se rachète à chaque cycle. C’est la seule marchandise qui rend plus qu’elle ne coûte.'],
  P:['P — La production','Dix heures. C’est ici, et nulle part ailleurs, que la valeur nouvelle apparaît.'],
  "M′":['M′ — Les marchandises','Elles contiennent les matières, le salaire et la plus-value — en caisses. Rien n’est acquis.'],
  "A′":['A′ — L’argent revenu','Vendre. Le bilan dira si A′ dépasse A, et de combien.']
};
function circuitCoachStep(){
  const c=CIRCUIT[step]||CIRCUIT[0];
  const guide=CIRCUIT_COACH[c.sym]||[c.sym,c.full||''];
  return {
    key:'circuit-'+c.sym,
    kicker: state.cycle===0 ? 'Premier circuit · cycle 1' : 'Le circuit',
    title:guide[0],
    body:`${guide[1]}<br><b>Prochaine destination :</b> ${displayZoneName(c.zone)}. Approche-toi puis appuie sur <b>E</b>.`,
    keys:['Suis la trace au sol','E : agir','Le bandeau du haut = le circuit'],
    tour:[
      {sel:'#circuit', label:'Étape du circuit', title:guide[0], body:`${guide[1]}<br>En ce moment, tu dois te rendre à <b>${displayZoneName(c.zone)}</b>.`, keys:['Le haut te rappelle où tu en es']},
      {sel:'#quest', label:'Prochaine destination', title:'Repère la prochaine destination.', body:`Le panneau <b>Objectif actuel</b> te rappelle aussi la prochaine étape : <b>${displayZoneName(c.zone)}</b>.`, keys:['La balise + l’objectif guident ton trajet']}
    ]
  };
}
function zoneActionCoachStep(){
  const z=document.getElementById('zoneact');
  if(!z || !z.classList.contains('on')) return null;
  const title=(document.getElementById('za-title')||{}).textContent||'Lieu';
  const left=(document.getElementById('za-actions')||{}).textContent||'actions restantes';
  const hasBtn=!!document.querySelector('#za-list .za:not(:disabled)');
  return {
    key:'zone-actions-'+title+'-'+left,
    emphasis:true,
    kicker:'Choisir une intervention',
    title:'Voici les boutons d’action.',
    body:`Tu es dans <b>${title}</b>. Les grandes cartes/boutons au centre sont les <b>interventions possibles</b>. Clique sur l’un d’eux pour dépenser une action.`,
    keys:['Cliquer un bouton = 1 intervention','Fermer = ne rien faire ici'],
    tour:[
      {sel:'#zoneact .box', label:'Fenêtre du lieu', title:`Fenêtre : ${title}`, body:'Cette fenêtre apparaît quand tu appuies sur <b>E</b> dans un bâtiment. Elle sert à choisir une intervention dans ce lieu.', keys:['E ouvre cette fenêtre']},
      {sel:'#za-actiontop', label:'Compteur d’actions', title:'Le compteur est ici.', body:`Ce badge rouge indique combien d’actions il reste : <b>${left}</b>. Il est placé en haut pour que tu le voies avant de choisir un bouton.`, keys:['Chaque clic consomme une action']},
      {sel:'#za-state', label:'État du lieu', title:'Lis rapidement l’état du lieu.', body:'Cette zone décrit la situation locale : production, dette, travail, stocks, marché, conflit, selon le bâtiment ouvert.', keys:['État local = contexte de décision']},
      {sel:'#za-list', label:'Interventions possibles', title:'Les actions sont ici.', body:`Chaque bouton est une intervention. Choisis une action utile, ou ferme la fenêtre si tu veux agir ailleurs.`, keys:['Boutons = actions jouables']},
      {sel:hasBtn?'#za-list .za:not(:disabled)':'#za-close', label:hasBtn?'Bouton à cliquer':'Fermer', title:hasBtn?'Clique une intervention.':'Aucune action disponible ici.', body:hasBtn?'Clique sur un de ces boutons : c’est cela, utiliser une action. Après le clic, le compteur baisse ; s’il reste des actions, tu peux repartir vers un autre bâtiment et recommencer.':'Ce lieu n’a pas d’action utile maintenant : ferme la fenêtre et va dans un autre bâtiment.', keys:hasBtn?['Un clic = une action consommée']:['Fermer puis changer de lieu']}
    ]
  };
}

function socialCoachStep(){
  if(state._socialTutorialDone) return null;
  const zstep=zoneActionCoachStep(); if(zstep) return zstep;
  const first=(state.cycle||0)<=2;
  if(!first) return null;

  if(state.actionsRestantes===3){
    return {
      key:'social-actions-start',
      emphasis:true,
      kicker:'Première période libre',
      title:'Fais d’abord tes 3 interventions.',
      body:'Une action ne se fait pas dans ce panneau : elle se fait sur la carte. Conduis vers un bâtiment, appuie sur <b>E</b>, puis clique un bouton d’intervention dans la fenêtre qui s’ouvre.',
      keys:['Bâtiment → E → bouton','1 bouton cliqué = 1 action utilisée'],
      tour:[
        {sel:'#f-actiontop', label:'Actions restantes', title:'Tu as 3 actions pour cette période.', body:'Le badge rouge indique combien d’interventions tu peux encore faire. Au début : <b>3 / 3</b>.', keys:['3 / 3 = trois décisions possibles']},
        {sel:'#f-howactions', label:'Mode d’emploi', title:'Voici comment dépenser une action.', body:'Suis ces trois gestes : <b>1</b> conduire vers un bâtiment, <b>2</b> appuyer sur E, <b>3</b> cliquer un bouton d’intervention.', keys:['C’est la procédure concrète']},
        {sel:'#formation', label:'Panneau de suivi', title:'Puis reviens au compteur.', body:'Après chaque bouton d’intervention cliqué, le compteur descend : <b>3 / 3</b>, puis <b>2 / 3</b>, puis <b>1 / 3</b>, puis <b>0 / 3</b>.', keys:['Quand il arrive à 0 : lance le cycle']}
      ]
    };
  }

  if(state.actionsRestantes>0){
    return {
      key:'social-actions-left-'+state.actionsRestantes,
      emphasis:true,
      kicker:'Période en cours',
      title:`Encore ${state.actionsRestantes} intervention(s).`,
      body:'Pour utiliser l’action restante : conduis vers un bâtiment, appuie sur <b>E</b>, puis clique un bouton d’intervention. Tu peux changer de bâtiment pour agir sur une autre tension.',
      keys:['Bâtiment → E → bouton','Le compteur baisse après le clic'],
      tour:[
        {sel:'#f-actiontop', label:'Actions restantes', title:`Il reste ${state.actionsRestantes} action(s).`, body:'Le badge rouge te dit combien d’interventions tu peux encore faire avant de lancer le cycle productif.', keys:['Tant qu’il en reste : agis sur la carte']},
        {sel:'#f-howactions', label:'Comment faire', title:'Répète cette procédure.', body:'Chaque action restante se dépense de la même manière : <b>aller à un bâtiment</b>, <b>appuyer sur E</b>, <b>cliquer un bouton</b>.', keys:['Même logique pour chaque action']}
      ]
    };
  }

  return {
    key:'social-end',
    emphasis:true,
    kicker:'Fin de période',
    title:'Maintenant, lance le cycle productif.',
    body:'Tu as utilisé tes interventions. Clique sur le bouton indiqué dans le panneau de droite : elles vont devenir production, vente, dette, stocks, conflit social et bilan.',
    keys:['Clique le bouton indiqué','Animation → bilan'],
    pulse:'f-resolve',
    tour:[
      {sel:'#f-cyclebox', label:'Lancer le cycle', title:'C’est ici : lance le cycle.', body:'Regarde cette zone sous les trois actions : la flèche et le bouton indiquent où cliquer pour transformer tes choix en <b>bilan</b>.', keys:['Ce bouton fait avancer l’histoire'], pulse:'f-resolve'},
      {sel:'#formation', label:'Lecture finale des panneaux', title:'Avant d’être autonome, retiens ce panneau.', body:'Ici tu relis l’âge historique, l’objectif, la contradiction dominante, le régime, les groupes sociaux et les actions restantes.', keys:['Droite = synthèse de la société']},
      {sel:'#circuit', label:'Diagnostic du circuit', title:'Et ici, le diagnostic du circuit.', body:'Les lettres ne sont plus seulement une route. Si elles deviennent rouges, elles signalent le lieu où le cycle se bloque.', keys:['Haut = diagnostic des tensions']}
    ]
  };
}
function tutorialCoachStep(){
  if(gameMode==='commune') return null;
  if(gameMode==='socialFormation') return socialCoachStep();
  if(gamePhase==='precapital') return foundingCoachStep();
  if(gamePhase==='circuit') return circuitCoachStep();
  return null;
}
(function wireTutorialCoach(){
  const b=document.getElementById('coach-min');
  if(b) b.addEventListener('click',()=>{
    TutorialCoach.minimized=!TutorialCoach.minimized;
    b.textContent=TutorialCoach.minimized?'+':'—';
    tutorialCoachRefresh(true);
  });
  const prev=document.getElementById('coach-prev');
  const next=document.getElementById('coach-next');
  if(prev) prev.addEventListener('click',()=>{ TutorialCoach.tourIndex=Math.max(0,TutorialCoach.tourIndex-1); tutorialCoachRefresh(true); });
  if(next) next.addEventListener('click',()=>{ TutorialCoach.tourIndex=TutorialCoach.tourIndex+1; tutorialCoachRefresh(true); });
})();


/* ---- Écran de concept : révélations majeures, une seule fois ---- */
// Écran de naissance du capital (fin de la phase 0) — déclenché manuellement
// Le prologue : qui l'on est, ce qu'on a, et pourquoi ce n'est pas encore du capital.
const PROLOGUE_SCREEN={stamp:'Prologue', title:'Tu as de l’argent. Ce n’est pas encore du capital.',
  body:`<p>Quatre cents livres — un héritage, le produit d’un comptoir, peu importe. Tant qu’elles dorment dans un coffre, elles ne sont que de l’argent : elles n’engendrent rien.</p>
    <p>Pour qu’elles deviennent du <b>capital</b>, il faut qu’elles partent et qu’elles reviennent plus nombreuses. Cela ne se fait pas tout seul. Il faut réunir deux choses qui n’existent pas encore ici : des <b>moyens de produire</b> — un atelier, des outils, des matières — et des gens qui n’ont rien d’autre à vendre que leur <b>force de travail</b>.</p>
    <p>Les premiers, tu vas les acheter. Les seconds, l’histoire va les fabriquer sous tes yeux.</p>
    <p class="how">Le chariot est ton corps dans ce monde : <b>Z Q S D</b> pour le conduire, <b>E</b> pour agir dans un lieu. La balise rouge dit où aller ; le carnet, en bas, dit ce que tu fais et ce que tu viens de faire.</p>`,
  unlock:['Acte I — Les moyens de production']};
// La clôture des communs : l'événement que l'on vient de regarder, et ce qu'il fabrique.
const ENCLOSURE_SCREEN={stamp:'Acte II · L’autre côté du marché', title:'Les communs sont clôturés',
  body:`<p>Une loi d’enclosure. Les champs ouverts deviennent la propriété de quelques-uns : les haies se ferment, le bétail est chassé, les droits d’usage sont abolis. Ceux qui vivaient de ces terres ne peuvent plus en vivre.</p>
    <p>Les voilà <b>libres</b> — au double sens du mot : libres de leur personne, et libres de tout moyen de production. C’est cette double liberté qui fait d’eux des vendeurs de force de travail. Trois d’entre eux attendent déjà à la place d’embauche.</p>
    <p>Marx appelle cela l’<b>accumulation primitive</b> : non pas l’épargne vertueuse d’un premier capitaliste, mais la séparation, par la violence, des producteurs et de leurs moyens de production (<i>Le Capital</i>, livre I, chap. XXVI).</p>`,
  unlock:['Place d’embauche ouverte — trois bras à vendre']};
// La naissance du capital, sur le compte du joueur : les chiffres sont ceux de
// SA production, pas d'un exemple. C'est ici qu'on comprend ce qu'on vient de
// faire — et d'où vient la différence.
function birthScreen(){
  const s=state, q=s._pcQ||0, rec=s._pcRecette||0, v=s._pcV||0, mat=s._pcMat||0, h=s._pcHeures||s.heures||10;
  const avance=v+mat, plus=rec-avance, neuf=rec-mat;              // valeur nouvelle = ce que le travail a ajouté aux matières
  const hNec = neuf>0 ? Math.min(h, h*v/neuf) : h, hSur=Math.max(0,h-hNec), pn=(hNec/h*100).toFixed(1);
  const hFr = x => x.toFixed(1).replace('.', ',');
  const fixe = UPGRADES.filter(u=>u.founding && u.cost>0).reduce((a,u)=>a+upgradeCost(u),0);   // atelier + outils
  const depart = s.argent + fixe - plus;                          // ce qu'il y avait dans le coffre au prologue
  return {stamp:'Fin de l’acte III — La rencontre', title:'Le capital est né',
   body:`<p>Reprends le compte de ce que tu viens de faire.</p>
     <div class="ledger">
       <span class="k">Avancé pour produire</span><span class="v">${money2(avance)}</span>
       <span class="k sub">salaire ${money2(v)} · matières ${money2(mat)}</span><span class="v sub"></span>
       <span class="k">Revenu de la vente</span><span class="v">${money2(rec)}</span>
       <span class="k sub">${q} marchandises × ${money2(s._pcPrix||s.prixUnitaire)}</span><span class="v sub"></span>
       <span class="k tot">Différence</span><span class="v tot">+ ${money2(plus)}</span>
     </div>
     <p>D’où viennent ces ${money2(plus)} ? Pas du marché : tu as acheté et vendu à leur valeur. De l’atelier. En ${h} heures, l’ouvrier a ajouté ${money2(neuf)} de valeur nouvelle aux matières ; tu lui en as payé ${money2(v)}. Le reste est à toi.</p>
     <div class="journee"><div class="jbar"><i style="width:${pn}%"></i></div>
       <div class="jleg"><span>≈ ${hFr(hNec)} h nécessaires<br>le salaire</span><span>≈ ${hFr(hSur)} h de surtravail<br>la plus-value</span></div></div>
     <p>Et ton coffre ? ${money(depart)} au départ, ${money2(s.argent)} maintenant. Les ${money(fixe)} qui manquent ne sont pas dépensés : ils sont <b>fixés</b> dans l’atelier et les outils, qui passeront leur valeur aux marchandises au fil de leur usure.</p>
     <div class="formula">A → M → Ft → P → M′ → <b>A′</b></div>
     <p>L’argent qui a fait cela ne fonctionne plus seulement comme argent : il fonctionne comme <b>capital</b>. Et il va recommencer.</p>`,
   unlock:['Le circuit A → A′ est ouvert','Touche V — lever le voile : la plus-value sous les prix'],
   onClose:()=>unlockVoile()};
}
// Concepts introduisant chaque cycle (clé = index du prochain objectif OBJECTIFS)
const CONCEPTS = {
  5:{stamp:'Nouvel objectif', title:'La concurrence',
     body:`<p>Tu n’es pas seul sur le marché. D’autres capitaux produisent la même marchandise et baissent leurs prix pour rafler la demande.</p>
       <p>Pour garder tes débouchés, il te faut <b>accumuler</b> : produire plus, moins cher — ou perdre ta part.</p>`,
     unlock:['Concept débloqué : CONTRAINTE CONCURRENTIELLE']},
  6:{stamp:'Nouvel objectif', title:'Le machinisme',
     body:`<p>La machine démultiplie ce qu’un ouvrier produit en une heure. C’est la <b>plus-value relative</b> : on arrache plus de valeur sans allonger la journée.</p>
       <p>Mais la machine remplace des bras : elle peut produire du chômage, et trop de marchandises d’un coup.</p>`,
     unlock:['Concept débloqué : PLUS-VALUE RELATIVE / MACHINISME']},
  8:{stamp:'Nouvel objectif', title:'La lutte des classes',
     body:`<p>Le capital dépend de la force de travail — mais il tend à l’épuiser, la discipliner et la comprimer.</p>
       <p>La grève rappelle que la force de travail n’est pas une marchandise comme les autres : elle peut <b>cesser d’agir comme capital variable</b> et bloquer le circuit.</p>`,
     unlock:['Concept débloqué : LUTTE DES CLASSES']},
  9:{stamp:'Nouvel objectif', title:'La réalisation',
     body:`<p>Produire de la valeur ne suffit pas : il faut la <b>réaliser</b>, c’est-à-dire vendre.</p>
       <p>Ce qui ne se vend pas devient stock — du capital immobilisé qui ne revient pas augmenté.</p>`,
     unlock:['Concept débloqué : RÉALISATION / SURPRODUCTION']},
  10:{stamp:'Nouvel objectif', title:'La crise',
     body:`<p>Quand trop de marchandises ne trouvent pas preneur, que la dette pèse et que le chômage monte, le circuit se grippe.</p>
       <p>La crise n’est pas un accident venu du dehors : elle <b>émerge des contradictions</b> du système lui-même.</p>`,
     unlock:['Concept débloqué : CRISE DE SURPRODUCTION']},
};
/* v47 — Phase 3 : la première contradiction n'est pas un cours, c'est un constat.
   Après les premières périodes sociales, on choisit LA contradiction que la partie
   du joueur a réellement produite, et on la montre comme chaîne causale vécue. */
function maybeShowFirstContradiction(){
  const st=state, d=st.d||{}, pv=st.prev||{};
  if(st._contradictionShown) return false;
  if(gameMode!=='socialFormation' || (st.cycle||0)<1) return false;
  let chain=null, titre='', lecture='';
  const stocksUp = st.stocks>(pv.stocks||0)+5 && (d.tauxVente??1)<0.95;
  const colereUp = st.colere>(pv.colere||0)+0.04;
  if(stocksUp){
    titre='Produire ne suffit pas';
    chain='Production ↑ → demande insuffisante → stocks ↑ → prix sous pression → profit menacé';
    lecture='La valeur produite n’est rien tant qu’elle n’est pas vendue : la surproduction n’est pas un excès de zèle, c’est une tendance du système.';
  } else if(colereUp && (st.heures>10 || st.salaire<5)){
    titre='Le profit a un coût social';
    chain=(st.heures>10?'Journée allongée':'Salaires comprimés')+' → plus-value ↑ → colère ouvrière ↑ → grève possible → circuit menacé au point P';
    lecture='Le rapport qui produit le profit produit aussi la résistance : exploiter la force de travail, c’est armer son antagoniste.';
  } else if((st.dette||0)>0){
    titre='Le crédit accélère — et endette';
    chain='Emprunt → investissement possible → intérêts chaque cycle → profit rogné → dépendance bancaire ↑';
    lecture='La banque n’offre pas du temps : elle le vend. Le crédit qui accélère l’accumulation précipite aussi la chute.';
  } else {
    titre='L’équilibre ne supprime rien';
    chain='Profit et paix sociale tenus ensemble → contradictions contenues → mais concurrence, stocks et dette continuent de travailler en silence';
    lecture='Équilibrer le système, c’est gagner du temps — pas abolir ses contradictions : elles se déplacent.';
  }
  st._contradictionShown=true;
  showConcept({stamp:'Première contradiction', title:titre,
    body:`<p>Voici ce que <b>ta</b> partie vient de produire :</p><div class="formula" style="font-size:14px;line-height:1.6">${chain}</div><p>${lecture}</p><p>Chaque solution déplacera la contradiction au lieu de la supprimer. C’est cela, jouer.</p>`,
    unlock:['Lecture débloquée : CONTRADICTION']});
  return true;
}
const FREE_MODE_CONCEPT={stamp:'Mode accumulation libre', title:'Le circuit continue',
  body:`<p>Parcours pédagogique terminé. Tu as traversé les grandes contradictions du capital : plus-value, concurrence, machine, dette, surproduction, crise.</p>
   <p>Le capital n’a pas de fin interne : il ne « gagne » pas définitivement. Il continue d’accumuler, de produire des contradictions et de traverser des crises.</p>`,
  unlock:['Mode accumulation libre — le circuit continue']};
const conceptShown=new Set();
// écrans de passage de stade (liés à niveauVille), une seule fois chacun
const STAGE_CONCEPTS={
  2:{stamp:'Passage de stade', title:'La manufacture',
     body:`<p>Le capital ne se contente plus de réunir un ouvrier et des outils.</p>
       <p>Il <b>organise plusieurs travailleurs</b> dans un même procès, divise les tâches et augmente la productivité collective.</p>`,
     unlock:['Stade atteint : Manufacture','Objectif suivant : résister à la concurrence']},
  3:{stamp:'Passage de stade', title:'Le machinisme',
     body:`<p>La machine accroît la puissance productive du travail.</p>
       <p>Mais elle augmente aussi le <b>capital constant</b>, la dette, l’usure et le risque de produire plus que le marché ne peut absorber.</p>`,
     unlock:['Stade atteint : Grande industrie']},
  4:{stamp:'Passage de stade', title:'La ville industrielle',
     body:`<p>Le capital ne transforme plus seulement l’atelier.</p>
       <p>Il transforme <b>l’espace social entier</b> : logements ouvriers, entrepôts, rails, marché, crédit et État deviennent les conditions de sa reproduction.</p>`,
     unlock:['Stade atteint : Ville industrielle']},
};
let conceptOnClose=null;
function showConcept(cfg){
  document.getElementById('concept-stamp').textContent=cfg.stamp||'Concept';
  document.getElementById('concept-title').textContent=cfg.title||'';
  document.getElementById('concept-body').innerHTML=cfg.body||'';
  const u=document.getElementById('concept-unlock');
  if(cfg.unlock&&cfg.unlock.length){ u.innerHTML=cfg.unlock.map(l=>`<span>${l}</span>`).join(''); u.style.display='flex'; }
  else u.style.display='none';
  conceptOnClose=cfg.onClose||null;
  document.getElementById('concept').classList.add('on');
}
function maybeShowConcept(enteringCycle){
  const cfg=CONCEPTS[enteringCycle];
  if(cfg && !conceptShown.has(enteringCycle)){ conceptShown.add(enteringCycle); showConcept(cfg); return true; }
  return false;
}
function maybeShowStageConcept(){
  refreshNiveauVille();                       // le stade peut monter par accumulation
  const niv=state.niveauVille, key='stade'+niv, cfg=STAGE_CONCEPTS[niv];
  if(cfg && !conceptShown.has(key)){ conceptShown.add(key); showConcept(cfg); return true; }
  return false;
}
let afterConcept=null;
document.getElementById('concept-ok').addEventListener('click',()=>{
  document.getElementById('concept').classList.remove('on');
  const fn=conceptOnClose; conceptOnClose=null; if(fn) fn();
  const cont=afterConcept; afterConcept=null;
  if(cont) cont(); else { renderQuest(); renderCircuitBar(); moveTargetMarker(); updateHUD(); }
  tutorialCoachRefresh(true);
});

// affiche/masque l'atelier (lecture seule) — visible seulement à l'usine ou cartes ouvertes
function showLevers(on){ const el=document.getElementById('levers'); if(el) el.style.display=on?'block':'none'; }


/* ===================================================================
   Interaction (touche E) + réalisation du cycle
   =================================================================== */
let currentZone=null, cooldownReal=0;

function interactZone(zone){
  if(gameOver || anyModalOpen()) return;
  if(typeof CinemaMode!=='undefined' && CinemaMode.isActive()) return;
  if(gameMode==='commune'){
    if(COMMUNE_ACTIONS[zone.name]) openCommuneActions(zone);
    else pushLog(zone.name,'Ce lieu appartient à l’ancien monde — il n’a plus de fonction dans la Commune.','warn');
    return;
  }
  if(gameMode==='socialFormation'){
    const cf=CompetitorWorld.byZone(zone.name);            // v48 : observation de la concurrence
    if(cf){ CompetitorWorld.openPanel(cf); return; }
    if(ZONE_ACTIONS[zone.name]) openZoneActions(zone);
    else pushLog(zone.name, (typeof ZONE_INFO!=='undefined'&&ZONE_INFO[zone.name])||'Pas d’intervention directe ici — observe, ou agis ailleurs.','warn');
    return;
  }
  if(gamePhase==='precapital'){
    const u=precapitalAction(zone.name);
    if(u){ doFounding(u); }
    else {
      const tz=precapitalTargetZone();
      pushLog('Fondation','Rien à faire ici pour l’instant'+(tz?` — prochaine étape : ${precapitalZoneLabel(tz)}.`:'.'),'warn');
    }
    return;
  }
  if(canInteractWithZone(zone)){
    const act=()=>performStep(zone);
    if(shouldPauseAt(zone)) showGuide(zone, act); else act();
    return;
  }
  // messages d'impossibilité utiles (prompt temporaire, pas de modale)
  if(zoneLocked(zone.name))
    pushLog(displayZoneName(zone.name),'Ce lieu sera utile plus tard : débloqué par l’accumulation.','warn');
  else if(CIRCUIT_ZONES.has(zone.name)){
    const need=CIRCUIT[step];
    pushLog(displayZoneName(zone.name),`Le circuit ne passe pas encore par ici. Va d’abord à ${displayZoneName(need.zone)} (${need.sym}).`,'warn');
  } else {
    pushLog(displayZoneName(zone.name), zoneInfo(zone.name) || 'Le circuit ne passe pas par ici.','warn');
  }
}

/* v47 : à chaque étape du premier circuit, le joueur voit IMMÉDIATEMENT
   quelle variable monte (▲) et laquelle baisse (▼), sur le lieu même. */
const STEP_FX={
  'Banque':            [['▲ argent disponible','gain'],['dette possible','warn']],
  'Marché des moyens': [['▼ argent','warn'],['▲ moyens de production','gain']],
  'Marché du travail': [['▼ argent (salaires)','warn'],['▲ force de travail','gain']],
  'Usine':             [['▲ marchandises','gain'],['▲ fatigue ouvrière','warn']],
  'Entrepôt':          [['▲ stocks','warn'],['valeur non réalisée','warn']],
};
function stepFloatFx(zoneName){
  const fx=STEP_FX[zoneName]; if(!fx||typeof floatText!=='function') return;
  const pz=zonePos(zoneName);
  fx.forEach((f,i)=> setTimeout(()=>floatText(f[0],{x:pz.x,y:9+i*3,z:pz.z},f[1]), 220+i*650));
}
// exécute réellement l'étape courante (après la pause guidée, le cas échéant)
function performStep(zone){
  if(zone.name==='Marché de vente'){ realizeCycle(); return; }
  const [title,text]=zone.action(); pushLog(title,text);
  stepFloatFx(zone.name);
  if(typeof LWmicro!=='undefined') LWmicro(zone.name);
  if(zone.name==='Usine'){
    if(!state.productionActive){
      showWhap({action:'Tu arrives au lieu de production.', fx:[['production impossible','-']], chain:null,
        marx:'Il n’y a pas encore de production : il faut construire un atelier et embaucher de la force de travail.'});
    } else if(state.cycle===0){
      // Premier circuit : on regarde la production se faire avec ce qu'on a.
      // Les décisions (journée, salaire, machines) viennent avec la formation
      // sociale, une fois le mouvement d'ensemble compris.
      showLevers(true);
      showWhap({action:`La production tourne : ${state.travailleurs} ouvrier, ${state.heures} h, l’atelier et ses outils.`,
        fx:[['marchandises','+'],['salaire et matières avancés','-']], chain:null,
        marx:'C’est ici que la valeur nouvelle apparaît — et nulle part ailleurs. Les décisions sur la journée, le salaire et les machines viendront au cycle suivant.'});
    } else { showLevers(true); openCards('usine'); }   // les cartes déclenchent leur propre "Ce qui vient de se passer"
  }
  else if(zone.name==='Banque' && state.cycle>2){ openCards('bank'); }  // crédit volontaire, jamais avant
  else { whapForZone(zone); }
  step++;
  renderCircuitBar(); renderQuest(); moveTargetMarker();
  updateHUD(); updateConsequences(); tutorialCoachRefresh(true);
}

function realizeCycle(){
  if(cooldownReal>0) return;
  cooldownReal=1.2;
  runCycle();                       // moteur économique : P → M′ → A′
  if(typeof checkAlerts==='function') checkAlerts();   // v47
  step=0;
  closeWhap();                      // pas de double explication : seul le bilan s'affiche
  showLevers(false);
  renderCircuitBar(); moveTargetMarker();
  updateConsequences();
  const toBilan=()=>{ showReport(); checkEndgame(); renderQuest(); tutorialCoachRefresh(true); };
  if(state.enGreve){ showGreveConflict(toBilan); }   // conflit social : le joueur décide d'abord
  else { toBilan(); }
}

/* ---- Conflit social : la grève comme événement et décision ---- */
function showGreveConflict(after){
  const s=state;
  const rev = s.revendication ? (REVENDICATIONS[s.revendication]||'de meilleures conditions') : 'de meilleures conditions';
  document.getElementById('greve-title').textContent='Grève';
  document.getElementById('greve-body').innerHTML=
    `<p>La force de travail cesse de fonctionner comme simple facteur de production. Le circuit du capital est bloqué au point même où il devait se valoriser.</p>`;
  const rv=document.getElementById('greve-revend');
  rv.innerHTML=`<span>Revendication ouvrière : ${rev}</span>`; rv.style.display='flex';
  const box=document.getElementById('greve-choices'); box.innerHTML='';
  const choices=[
    {lab:'Céder partiellement', sub:'salaire ou journée concédés · colère ↓ · profit ↓ · la grève cesse',
     act:()=>{
       if(s.revendication==='journee' && s.heures>8){ s.heures-=1; }
       else if(s.revendication==='securite'){ s.securiteNiveau++; s.argent-=40; }
       else { s.salaire+=1; }
       apaiserOuvriers(0.20,'grève : concession'); s.enGreve=false; s.revendication=null;
       s.modeEtat='réforme'; s.d.concession=true;
     }},
    {lab:'Réprimer la grève', sub:'production reprend · colère ↓ un peu · conscience ↑ · explosion possible plus tard',
     act:()=>{
       s.argent-=30; s.colere=clamp(s.colere-0.10); s.conscience=clamp(s.conscience+0.10);
       s.enGreve=false; s.modeEtat='répression'; s.d.repression=true;
       rememberEvent(s,'workers','repression','grève réprimée');
     }},
    {lab:'Attendre', sub:'la production reste bloquée · la colère peut monter · rien n’est tranché',
     act:()=>{
       s.colere=clamp(s.colere+0.05); s.d.greveAttendue=true; /* enGreve reste vrai */
     }},
  ];
  choices.forEach(c=>{
    const b=document.createElement('button'); b.className='go'; b.style.textAlign='left';
    b.innerHTML=`${c.lab}<br><span style="font-weight:400;font-size:11px;opacity:.8">${c.sub}</span>`;
    b.onclick=()=>{ c.act(); updateHUD(); updateConsequences();
      document.getElementById('greve').classList.remove('on'); after(); };
    box.appendChild(b);
  });
  document.getElementById('greve').classList.add('on');
}

function unlockVoile(){
  voileUnlocked=true;
  const h=document.getElementById('help-voile'); if(h) h.style.opacity='1';
}

/* ---- bilan de fin de cycle ---- */
function interpretation(s){
  const phr=[];
  if(s.d.invendus>5) phr.push('Tu as extrait de la plus-value à l’atelier, mais une partie des marchandises ne trouve pas preneur : produire ne suffit pas, encore faut-il vendre.');
  else if((s.d.tauxExploitation||0)>0.6) phr.push('Le profit que tu encaisses ne sort pas de l’échange : il vient du surtravail, ces heures que l’ouvrier donne au capital sans contrepartie.');
  else phr.push('L’argent est revenu augmenté : ce supplément, c’est la plus-value créée par le travail vivant et réalisée sur le marché.');
  if(s.enGreve) phr.push('La force de travail vient de rappeler qu’elle n’est pas une simple marchandise : la grève bloque le circuit.');
  else if(s.chomage>(s.prev.chomage||0)+0.03) phr.push('En économisant du travail, tu grossis l’armée de réserve des sans-emploi — la même qui fait pression à la baisse sur les salaires.');
  else if((s.d.compoOrganique||0)>3) phr.push('Plus tu remplaces les bras par des machines, plus la part qui crée la valeur se réduit : c’est ce qui tend à comprimer le taux de profit.');
  else if(s.d.declenche) phr.push('La crise n’est pas un accident venu du dehors : c’est le circuit lui-même qui se grippe quand la valeur produite ne peut plus se réaliser.');
  else phr.push('Mais chaque profit laisse une trace : stocks, fatigue, chômage — les contradictions s’accumulent avec le capital.');
  return phr.slice(0,2).join(' ');
}
// Une phrase courte : le concept-clé du cycle (staging pédagogique)
function pourquoi(s){
  if(s.cycle===1) return 'Tu viens de voir le geste de base : faire circuler l’argent (A → … → A′) pour qu’il revienne augmenté.';
  if(s.enGreve) return 'La force de travail n’est pas une marchandise comme les autres : trop pressée, elle bloque le circuit.';
  if((s.d.invendus||0)>20) return 'Produire ne suffit pas : tant que les marchandises ne sont pas vendues, la plus-value reste virtuelle.';
  if((s.d.compoOrganique||0)>3) return 'Plus tu mécanises, plus la part de travail vivant (qui seul crée la valeur) se réduit : le taux de profit tend à baisser.';
  if(s.d.declenche) return 'La crise vient du circuit lui-même : la valeur produite ne trouve plus à se réaliser.';
  if(s.chomage>(s.prev.chomage||0)+0.03) return 'Le profit a un revers : l’armée de réserve des chômeurs grossit et pèse sur les salaires.';
  return 'Le supplément d’argent ne sort pas de l’échange : il vient du surtravail extrait à l’usine — la plus-value.';
}
// Enchaînement causal éventuel du cycle (court, seulement si un phénomène domine)
function bilanChaine(s){
  if(s.enGreve) return ['Colère trop forte','→ grève','→ production bloquée'];
  if(s.d.declenche) return ['Surproduction + dette','→ mévente','→ crise','→ licenciements'];
  if((s.d.invendus||0)>40) return ['Trop produit','→ invendus','→ stocks qui s’accumulent'];
  if(s.chomage>(s.prev.chomage||0)+0.05) return ['Moins de bras','→ chômage en hausse','→ pression sur les salaires'];
  return null;
}
function fmtDeltaMoney(v){ const r=Math.round(v);
  if(r>0) return `<span class="up">+${money(r)} ↑</span>`;
  if(r<0) return `<span class="dn">−${money(Math.abs(r))} ↓</span>`;
  return `<span class="flat">0 £ →</span>`; }
function fmtDeltaPct(v){ const p=Math.round(v*100);
  if(p>0) return `<span class="up">+${p} % ↑</span>`;
  if(p<0) return `<span class="dn">${p} % ↓</span>`;
  return `<span class="flat">0 % →</span>`; }
function fmtDeltaInt(v){ const r=Math.round(v);
  if(r>0) return `<span class="up">+${r} ↑</span>`;
  if(r<0) return `<span class="dn">${r} ↓</span>`;
  return `<span class="flat">0 →</span>`; }
// une phrase qui explique le tour
function bilanAuto(s,d){
  const inv=d.invendus||0, prodres=d.resultatProductif||0, net=d.resultatNet||0, p=s.prev||{};
  if(s.enGreve) return 'Le circuit est bloqué dans la production : la force de travail cesse d’agir comme capital variable.';
  if(d.repression) return 'La production reprend, mais la contradiction sociale n’est pas supprimée : elle est seulement déplacée.';
  if(d.concession) return 'Le capital concède une part de valeur pour préserver la continuité du circuit.';
  if(d.accident) return 'La force de travail a été usée au-delà de ses conditions normales de reproduction.';
  if(d.stagne) return 'Ton capital stagne pendant que les autres avancent : accumuler ou être dépassé.';
  if((d.interets||0) > prodres && prodres > 0) return 'L’atelier est rentable, mais la dette absorbe tout le profit.';
  if(net<0 && prodres<0) return 'Le cycle est déficitaire : les coûts avancés dépassent la recette de vente.';
  if(inv>5) return 'Une partie de la valeur produite n’a pas été réalisée : les marchandises restent en stock.';
  if((d.tauxExploitation||0) > (p.tauxExploitation||0)+0.05 && s.colere > (p.colere||0)+0.02)
    return 'La baisse du capital variable augmente le taux d’exploitation, mais fragilise la reproduction de la force de travail.';
  if(s.colere > (p.colere||0)+0.04) return 'La rentabilité immédiate s’accompagne d’une tension sociale plus forte.';
  if(s.cycle>3 && (d.partJoueur||1) < 0.22) return 'Tes concurrents accumulent : sans réinvestir, ta part de marché s’érode — accumuler ou être dépassé.';
  if(s.fatigue > (p.fatigue||0)+0.04) return 'La plus-value absolue augmente, mais la fatigue et la colère progressent.';
  if(net>0 && inv<=5) return 'Le cycle est profitable : la marchandise a été vendue et l’argent revient augmenté.';
  return 'Le supplément d’argent ne vient pas de l’échange, mais du surtravail extrait à l’usine.';
}
// 2 lectures marxiennes courtes, choisies selon le tour
function bilanLecturesMarx(s,d){
  const out=[]; const inv=d.invendus||0;
  if((d.interets||0) > (d.resultatProductif||0) && (d.resultatProductif||0) > 0)
    out.push('Le capital financier prélève une part du profit produit dans l’atelier : ici le cycle productif est rentable, mais la charge de la dette rend le résultat net négatif.');
  if(s.chomage>0.2)
    out.push('Le chômage n’est pas extérieur au système : il devient une réserve de main-d’œuvre qui pèse sur les salaires.');
  out.push('Le profit monétaire vient de l’écart entre les coûts avancés et la recette obtenue.');
  if(inv>3) out.push('Les stocks signalent une valeur produite mais non encore réalisée par la vente.');
  else if(out.length<2) out.push('La valeur produite ne compte pour le capital que si elle est réalisée par la vente.');
  return out.slice(0,3);
}
function showReport(){
  const s=state, d=s.d, p=s.prev||{};
  const premier = s.cycle===1;   // premier circuit bouclé : le compte et une lecture, pas le grand livre
  const obj=objectifCourant();
  const reussi=obj.ok(s);
  const gauge=obj.gauge?obj.gauge(s):'';
  const manque=(!reussi && obj.manque)?obj.manque(s):'';
  const aide=(!reussi && s.objectifCyclesSurPlace>=2)?objHint():'';
  const sheet=document.getElementById('report-sheet');
  const produites=Math.round(d.Q||0), vendues=Math.round(d.unitesVendues||0), stock=Math.round(s.stocks);
  const invendus=Math.round(d.invendus||0);
  const offre=(p.stocks||0)+(d.Q||0);
  const tauxVente=offre>0 ? Math.round(vendues/offre*100) : 0;
  const prixVente=vendues>0 ? d.recette/vendues : (d.nouveauPrix||s.prixUnitaire);
  const prodres=d.resultatProductif||0, net=d.resultatNet||0;
  const aDette=(d.detteFin||0)>0 || (d.creditPris||0)>0 || (d.detteRemb||0)>0;
  const compte=`
    <div class="repsec">Compte du cycle</div>
    <div class="led compte">
      <span class="k">Argent au début du cycle</span><span class="v">${money(p.argent||0)}</span>
      <span class="k">Salaires avancés</span><span class="v red">− ${money(d.v||0)}</span>
      <span class="k">Matières premières</span><span class="v red">− ${money(d.matieres||0)}</span>
      <span class="k">Usure outils / machines</span><span class="v red">− ${money(d.usure||0)}</span>
      <span class="k">Recette de vente</span><span class="v gold">+ ${money(d.recette||0)}</span>
      <span class="k">Résultat productif (atelier)</span><span class="v tot ${prodres>=0?'gold':'red'}">${prodres>=0?'+ ':'− '}${money(Math.abs(prodres))}</span>
      <span class="k">Intérêts</span><span class="v red">${(d.interets||0)>0?'− '+money(d.interets):'—'}</span>
      <span class="k">Impôts</span><span class="v red">${(d.impot||0)>0?'− '+money(d.impot):'—'}</span>
      <span class="k">Résultat net du cycle</span><span class="v tot ${net>=0?'gold':'red'}">${net>=0?'+ ':'− '}${money(Math.abs(net))}</span>
      <span class="k">Argent final</span><span class="v tot gold">${money(s.argent)}</span>
    </div>`;
  const detteBloc = aDette ? `
    <div class="repsec">Dette</div>
    <div class="led">
      <span class="k">Dette au début</span><span class="v">${money(d.detteDebut||0)}</span>
      <span class="k">Nouveau crédit</span><span class="v ${(d.creditPris||0)>0?'red':''}">${(d.creditPris||0)>0?'+ '+money(d.creditPris):'—'}</span>
      <span class="k">Dette remboursée</span><span class="v ${(d.detteRemb||0)>0?'gold':''}">${(d.detteRemb||0)>0?'− '+money(d.detteRemb):'—'}</span>
      <span class="k">Dette finale</span><span class="v ${(d.detteFin||0)>0?'red':''}">${money(d.detteFin||0)}</span>
      <span class="k">Taux d’intérêt</span><span class="v">${pct(d.taux||0)}</span>
      <span class="k">Intérêts payés</span><span class="v red">${(d.interets||0)>0?'− '+money(d.interets):'—'}</span>
    </div>${(d.machineAchat||0)>0?'<p class="dnote">La dette vient de l’achat de machine à crédit.</p>':''}` : '';
  // --- Concurrence & réserve de main-d'œuvre : révélées une fois le circuit compris ---
  let concurrence='', reserve='';
  if(s.cycle>2){
    const comp=(s.competitors||[]).filter(c=>c.vivant);
    const part=s.d.partJoueur||0, prevPart=(p.partJoueur!=null?p.partJoueur:part);
    const cheapest=comp.reduce((m,c)=>c.prix<m.prix?c:m,{prix:Infinity,nom:'—'});
    const ecartPrix=Math.round((s.prixUnitaire-cheapest.prix)/Math.max(0.01,cheapest.prix)*100);
    const pression = part>0.30?'faible':(part>=0.20?'moyenne':'forte');     // seuils par part de marché
    let phrase='';
    if(part < prevPart-0.01) phrase='Tes concurrents vendent moins cher : une partie de la demande se détourne de tes marchandises.';
    else if(part > prevPart+0.01) phrase='Ton capital conquiert une plus grande part du marché.';
    concurrence=`
      <div class="repsec">Concurrence</div>
      <div class="led">
        <span class="k">Part de marché du joueur</span><span class="v ${part<0.20?'red':'gold'}">${pct(part)}</span>
        <span class="k">Concurrent le moins cher</span><span class="v">${cheapest.nom} · ${money2(cheapest.prix)}</span>
        <span class="k">Pression concurrentielle</span><span class="v ${pression==='forte'?'red':''}">${pression}</span>
        <span class="k">Écart de prix</span><span class="v ${ecartPrix>0?'red':''}">${ecartPrix>=0?'+':''}${ecartPrix} %</span>
      </div>${phrase?`<p class="dnote">${phrase}</p>`:''}`;
    const emploi=s.travailleurs, chom=Math.max(0,Math.round((s.populationActive||0)-s.travailleurs));
    const pSal=s.chomage<0.10?'faible':(s.chomage<0.25?'moyenne':'forte');
    reserve=`
      <div class="repsec">Réserve de main-d’œuvre</div>
      <div class="led">
        <span class="k">Employés</span><span class="v">${emploi}</span>
        <span class="k">Chômeurs</span><span class="v ${chom>0?'red':''}">${chom}</span>
        <span class="k">Pression sur les salaires</span><span class="v ${pSal==='forte'?'red':''}">${pSal}</span>
      </div>`;
  }
  // --- Rapport de force social & État ---
  let social='', etat='';
  if(s.cycle>2){
    const rapport=(d.rapportSocial!=null?d.rapportSocial:rapportDeForceSocial(s));
    const rfLab=rapport<0.4?'faible':(rapport<0.68?'moyen':'fort');
    const rev=s.revendication?(REVENDICATIONS[s.revendication]||'—'):'aucune';
    social=`
      <div class="repsec">Rapport de force social</div>
      <div class="led">
        <span class="k">Colère</span><span class="v ${s.colere>0.6?'red':''}">${pct(s.colere)}</span>
        <span class="k">Conscience collective</span><span class="v">${pct(s.conscience)}</span>
        <span class="k">Peur du chômage</span><span class="v">${pct(s.peurChomage)}</span>
        <span class="k">Rapport de force</span><span class="v ${rfLab==='fort'?'red':''}">${rfLab}</span>
        <span class="k">Revendication ouvrière</span><span class="v ${s.revendication?'red':''}">${rev}</span>
      </div>`;
    if(s.modeEtat || d.repression || d.concession || d.sauvetage || d.loiJournee){
      const mode=s.modeEtat||'laisser-faire';
      let raison='—';
      if(d.sauvetage) raison='crise'; else if(d.repression||d.concession) raison='grève';
      else if(d.accident) raison='accident'; else if(s.colere>0.6) raison='colère élevée';
      let effet='—';
      if(d.loiJournee) effet=`journée limitée à ${d.loiJournee} h`;
      else if(d.concession) effet='concession (salaire/journée)';
      else if(d.repression) effet='répression de la grève';
      else if(d.sauvetage) effet='soutien de la demande, impôt';
      etat=`
      <div class="repsec">État</div>
      <div class="led">
        <span class="k">Mode</span><span class="v ${(mode==='répression')?'red':''}">${mode}</span>
        <span class="k">Raison</span><span class="v">${raison}</span>
        <span class="k">Effet</span><span class="v">${effet}</span>
      </div>`;
    }
  }
  const stk=Math.round(s.stocks);
  const stockNiv = stk<40?{t:'normal',c:''}:(stk<100?{t:'inquiétant',c:'red'}:(stk<180?{t:'critique',c:'red'}:{t:'surproduction ouverte',c:'red'}));
  const stockNote = stk>=40 ? `<p class="dnote">Stocks ${stockNiv.t} (${stk}) — une partie de la valeur est produite, mais non réalisée.</p>` : '';
  const prodvente=`
    <div class="repsec">Production et vente</div>
    <div class="led">
      <span class="k">Marchandises produites</span><span class="v">${produites}</span>
      <span class="k">Marchandises vendues</span><span class="v">${vendues}</span>
      <span class="k">Invendus</span><span class="v ${invendus>0?'red':''}">${invendus}</span>
      <span class="k">Prix unitaire</span><span class="v">${money2(prixVente)}</span>
      <span class="k">Taux de vente</span><span class="v">${tauxVente} %</span>
      <span class="k">Niveau des stocks</span><span class="v ${stockNiv.c}">${stockNiv.t}</span>
    </div>${stockNote}`;
  const variations=`
    <div class="repsec">Variations du tour</div>
    <div class="led">
      <span class="k">Argent</span><span class="v">${fmtDeltaMoney(s.argent-(p.argent||0))}</span>
      <span class="k">Stocks</span><span class="v">${fmtDeltaInt(s.stocks-(p.stocks||0))}</span>
      <span class="k">Taux d’exploitation</span><span class="v">${fmtDeltaPct((d.tauxExploitation||0)-(p.tauxExploitation||0))}</span>
      <span class="k">Taux de profit</span><span class="v">${fmtDeltaPct((d.tauxProfit||0)-(p.tauxProfit||0))}</span>
      <span class="k">Tension sociale</span><span class="v">${fmtDeltaPct(s.colere-(p.colere||0))}</span>
      <span class="k">Fatigue</span><span class="v">${fmtDeltaPct(s.fatigue-(p.fatigue||0))}</span>
      <span class="k">Chômage</span><span class="v">${fmtDeltaPct(s.chomage-(p.chomage||0))}</span>
      <span class="k">Risque de crise</span><span class="v">${fmtDeltaPct((d.risqueCrise||0)-(p.risqueCrise||0))}</span>
    </div>`;
  const lectures = premier
    ? '<div>Le même mouvement qu’à la fondation, mais comme un cycle qui se répète : l’argent avancé — salaires, matières — revient par la vente, et la différence vient du travail non payé. Ce que tu as vu naître une fois va maintenant se reproduire, ou se gripper.</div>'
    : bilanLecturesMarx(s,d).map(l=>`<div>${l}</div>`).join('');
  sheet.innerHTML=`
    <div class="stamp">Registre · An ${1800+s.cycle} · ${obj.titre}</div>
    <h3>${premier?'Premier cycle bouclé':'Bilan du cycle '+s.cycle}</h3>
    <p class="verdict ${reussi?'ok':'ko'}">${reussi?'✓ Objectif validé — étape pédagogique suivante débloquée':'✗ Objectif non atteint — le prochain cycle conserve le même objectif'}</p>
    <p class="objline"><b>Objectif :</b> ${obj.but}${gauge?`<br><span class="gauge">${gauge}</span>`:''}${manque?`<br><span class="manque">Ce qu’il manque : ${manque}</span>`:''}${aide?`<br><span class="aide">💡 ${aide}</span>`:''}</p>
    ${compte}
    ${detteBloc}
    ${prodvente}
    ${concurrence}
    ${reserve}
    ${social}
    ${etat}
    ${premier?'':variations}
    ${premier?'':`<div class="auto">${bilanAuto(s,d)}</div>`}
    <div class="interp"><div class="veilline">Lecture marxienne</div>${lectures}</div>
    <button class="go" id="report-go">${premier?'Continuer ▸':`Repartir pour le cycle ${s.cycle+1} ▸`}</button>`;
  document.getElementById('report').classList.add('on');
  document.getElementById('report-go').onclick=()=>{
    document.getElementById('report').classList.remove('on');
    if(gameOver) return;
    proceedAfterReport();
  };
}
// après le bilan : éventuel écran de concept, puis reprise.
function resumePlay(){ renderQuest(); renderCircuitBar(); moveTargetMarker(); updateHUD(); updateVilleBadge(); tutorialCoachRefresh(true); }
function upgradesUnlocked(){ return (state.age||0)>=3; } // Grande industrie : les améliorations/planification avancée commenceront ici
function maybeOpenUpgradeAfterCycle(){
  if(upgradesUnlocked()) openUpgrade(resumePlay);
  else resumePlay();
}
function proceedAfterReport(){
  const reussi = objectifCourant().ok(state);
  const toUpgrade=()=>maybeOpenUpgradeAfterCycle();
  if(reussi){
    state.objectifCyclesSurPlace = 0;
    state.objectifIndex++;
    if(state.objectifIndex>=OBJECTIFS.length){       // parcours pédagogique bouclé → accumulation libre
      state.objectifIndex = OBJECTIFS.length;        // reste sur OBJ_GENERIQUE, le jeu continue
      if(!conceptShown.has('libre')){ conceptShown.add('libre'); showConcept(FREE_MODE_CONCEPT); afterConcept=toUpgrade; }
      else { toUpgrade(); }
      return;
    }
    if(maybeShowStageConcept()){ afterConcept=toUpgrade; }
    else if(maybeShowConcept(state.objectifIndex)){ afterConcept=toUpgrade; }
    else { toUpgrade(); }
  } else {
    // le capital continue de tourner, mais la progression pédagogique reste bloquée
    state.objectifCyclesSurPlace++;
    toUpgrade();
  }
}

/* ===================================================================
   Conditions de victoire / défaite
   =================================================================== */
function endStreak(s,key,cond){ s._endStreaks=s._endStreaks||{}; s._endStreaks[key]=cond?((s._endStreaks[key]||0)+1):0; return s._endStreaks[key]; }
function checkEndgame(){
  const s=state;
  crisisStreak = (s.d.risqueCrise||0)>0.95 ? crisisStreak+1 : 0;
  // --- mode guidé / tutoriel : seulement les défaites dures ---
  if(typeof gameMode==='undefined' || gameMode!=='socialFormation'){
    let fin=null;
    if(s.argent < -200) fin={win:false, t:'Défaite économique', d:'Le capital avancé ne revient plus : la dette a dépassé ce que le circuit pouvait nourrir. Faillite.'};
    else if(s.colere>0.95 && s.enGreve) fin={win:false, t:'Défaite sociale', d:'Grève générale. La colère est devenue collective et la production s’est arrêtée. La force de travail a brisé le circuit.'};
    else if(crisisStreak>=2) fin={win:false, t:'Défaite systémique', d:'La crise s’installe durablement : la valeur produite ne se réalise plus. Le circuit s’effondre sur lui-même.'};
    if(fin) endGame(fin);
    return;
  }
  // --- formation sociale : issues HISTORIQUES émergentes (pas seulement l'argent) ---
  const g=s.groups||{}, r=s.regime||{}, rk=s.ranking||{};
  const revo=(g.revolutionaries?g.revolutionaries.force:0), org=(g.workers?g.workers.organisation:0);
  // DÉFAITES
  if(s.argent < -200){ endGame({win:false,t:'Faillite',
    d:'Le capital avancé ne revient plus : la dette a dépassé ce que le circuit pouvait nourrir. L’entreprise s’éteint, ses machines partent à vil prix — le capital se concentre ailleurs.'}); return; }
  const collapse=(s.colere>0.85 && (r.legitimacy||0.5)<0.28 && revo>0.6 && (r.communistPossibility||0)<0.6);
  if(endStreak(s,'collapse',collapse)>=2){ endGame({win:false,t:'Effondrement social',
    d:'La colère est devenue insurrection sans projet : ni le capital ni une alternative ne parviennent à tenir le monde. La formation sociale se disloque dans le chaos.'}); return; }
  if(crisisStreak>=3){ endGame({win:false,t:'Crise systémique prolongée',
    d:'La valeur produite ne se réalise plus, cycle après cycle. Surproduction et dette nouent une crise dont le circuit ne sort plus : il s’effondre sur lui-même.'}); return; }
  // ISSUES HISTORIQUES — configurations stabilisées, à partir de la Grande industrie
  if((s.age||0)>=3){
    if(endStreak(s,'commune', r.type==='communisteFragile' && (r.communistPossibility||0)>0.6 && org>0.55)>=2){
      enterCommune(); return; }
    if(endStreak(s,'socdem', r.type==='socialDemocrate' && (r.legitimacy||0)>0.6 && s.colere<0.36)>=3){
      endGame({win:true,t:'Le capital réformé',
        d:'Droits sociaux, salaires stabilisés, syndicats reconnus : le conflit de classe est canalisé dans des institutions. Le capital continue, mais sous compromis — un capitalisme régulé s’est stabilisé.'}); return; }
    if(endStreak(s,'autoritaire', r.type==='autoritaire' && (r.repression||0)>0.6 && s.colere<0.42)>=3){
      endGame({win:true,t:'Le capital durci',
        d:'L’ordre règne par la force : la contestation est matée, l’État discipline le travail au service de l’accumulation. La paix sociale est imposée — fragile, mais tenue.'}); return; }
    const triomphe=((rk.rankLevel||0)>=6) || (rk.productivePower>0.7 && rk.marketPower>0.7 && rk.financialPower>0.6);
    if(endStreak(s,'monopole', triomphe)>=3){
      endGame({win:true,t:'Le capital monopoliste',
        d:'L’accumulation a tout absorbé : concurrents rachetés, marché dominé, finance maîtresse. Le capital triomphe — au prix d’un monde traversé de tensions qu’il devra contenir sans fin.'}); return; }
  }
}
function endGame(fin){
  gameOver=true;
  if(targetMarker) targetMarker.visible=false;
  const sheet=document.getElementById('report-sheet');
  document.getElementById('report').classList.add('on','final');
  sheet.innerHTML=`
    <div class="stamp">${fin.win?'Issue historique':'Fin de partie'}</div>
    <p class="grandtitle">${fin.t}</p>
    <p class="verdict ${fin.win?'ok':'ko'}">Âge : ${AGES[state.age||1]||'—'} · Rang : ${(state.ranking&&state.ranking.rankName)||'—'}${state.regime?(' · '+(REGIME_LABEL[state.regime.type]||state.regime.type)):''}</p>
    <div class="interp">${fin.d}</div>
    <p style="opacity:.7;font-size:12px;margin-top:6px">Cycle ${state.cycle} · ${money(state.argent)} · ${historyLog.length} événements vécus</p>
    <button class="go" id="report-go">Rejouer ▸</button>`;
  document.getElementById('report-go').onclick=()=>location.reload();
}

/* ===================================================================
   LA COMMUNE — mode post-capitaliste jouable (§16-17)
   La logique s'inverse : on ne cherche plus à accumuler (A→A′), on cherche
   à coordonner le travail pour couvrir les BESOINS. Trois tensions
   nouvelles : la PÉNURIE (ajuster production et besoins sans marché),
   la DÉMOCRATIE (la participation contre l'apathie), la BUREAUCRATIE
   (la coordination qui se fige en appareil). Issues : la Commune tient,
   ou elle dégénère (révolution confisquée), ou elle s'effondre.
   =================================================================== */
function initCommune(s){
  const pop = Math.max(s.travailleurs+ (Math.max(0,Math.round((s.populationActive||0)-s.travailleurs))), 12);
  s.commune={
    an:1,
    population: pop,
    besoins: pop*1.0,                 // besoins sociaux ≈ population
    production: s.travailleurs*1.0,    // ce que le travail collectif produit
    stocksCommuns: 20,
    participation: clamp(0.5 + (s.groups&&s.groups.workers?s.groups.workers.organisation*0.3:0)),
    bureaucratie: 0.15,
    penurie: 0,
    coordination: 0.4,
    planProd: s.travailleurs*1.0,      // niveau de production planifié par le joueur
  };
}
function enterCommune(){
  if(gameMode==='commune') return;
  gameMode='commune';
  initCommune(state);
  state.actionsRestantes=3;
  stageMode();
  // Fermer le bilan est un geste d'ENTRÉE, pas de mise en scène : on ne
  // referme pas une modale à chaque restauration.
  const rp=document.getElementById('report'); if(rp) rp.classList.remove('on');
  addHistoricalEvent('age','La Commune : l’accumulation cède la place à la coordination. Un autre monde commence.');
  renderFormationPanel();
  showConcept({stamp:'Un autre monde', title:'La Commune — le capital dépassé',
    body:'<p>La classe ouvrière organisée a brisé le circuit du capital. Le but n’est plus d’<b>accumuler</b> : il est de <b>coordonner le travail pour couvrir les besoins</b>.</p><p>De nouvelles tensions surgissent. Sans marché ni profit, comment ajuster la production aux besoins sans <b>pénurie</b> ? Comment décider <b>démocratiquement</b> sans sombrer dans l’<b>apathie</b> — ni laisser la coordination se figer en <b>bureaucratie</b> ?</p><p>Les lieux changent de sens (touche <b>E</b>) : l’usine se planifie, le quartier délibère, l’entrepôt se répartit.</p>',
    unlock:['Coordonner, ne plus accumuler','Couvrir les besoins · éviter la pénurie','Démocratie vs bureaucratie']});
}
function runCommuneCycle(){
  const c=state.commune, s=state;
  // la production effective suit le plan, tempérée par la participation (travail volontaire) et freinée par la bureaucratie
  const effPart=0.6+0.5*c.participation;            // participation → entrain au travail
  const effBur=1-0.35*c.bureaucratie;               // bureaucratie → gaspillage/friction
  c.production = Math.max(0, c.planProd * effPart * effBur);
  // les besoins croissent doucement avec la population
  c.population = Math.round(c.population*(1+0.01));
  c.besoins = c.population*1.0;
  // bilan matériel : offre = production + stocks communs
  const offre = c.production + c.stocksCommuns;
  const solde = offre - c.besoins;
  if(solde>=0){ c.stocksCommuns = Math.min(c.besoins*1.5, solde); c.penurie = clamp(c.penurie-0.18); }
  else { c.stocksCommuns = 0; c.penurie = clamp(c.penurie + Math.min(0.4, -solde/Math.max(1,c.besoins))); }
  // coordination = adéquation production/besoins (1 = parfaitement ajusté)
  c.coordination = clamp(1 - Math.abs(c.production - c.besoins)/Math.max(1,c.besoins));
  // dérives lentes : sans entretien démocratique, la participation s'érode et la bureaucratie monte
  c.participation = clamp(c.participation - 0.04 - (c.penurie>0.5?0.04:0));
  c.bureaucratie = clamp(c.bureaucratie + 0.03 + (c.participation<0.35?0.05:0) + (c.penurie>0.6?0.04:0) - (c.participation>0.65?0.03:0));
  // chronique
  const bits=[];
  if(c.penurie>0.5) bits.push('la pénurie frappe les quartiers');
  else if(c.stocksCommuns>c.besoins*0.6) bits.push('les réserves communes s’emplissent');
  else bits.push('les besoins sont à peu près couverts');
  if(c.bureaucratie>0.55) bits.push('l’appareil s’alourdit');
  if(c.participation>0.6) bits.push('les assemblées sont vivantes');
  addHistoricalEvent('chronique',`An ${c.an} de la Commune — ${bits.join(', ')}.`);
}
const COMMUNE_ACTIONS={
 'Usine':[
   {label:'Planifier la production', sub:'ajuster le plan aux besoins · + coordination', can:()=>true, run:()=>{ const c=state.commune; c.planProd=c.besoins; c.coordination=clamp(c.coordination+0.12); pushLog('Usine','Le plan est calé sur les besoins recensés : produire ce qui est utile, pas ce qui se vend.'); }},
   {label:'Pousser le rendement', sub:'+ production · − participation (travail contraint)', can:()=>true, run:()=>{ const c=state.commune; c.planProd=c.planProd*1.2; c.participation=clamp(c.participation-0.08); c.bureaucratie=clamp(c.bureaucratie+0.04); pushLog('Usine','On force la cadence : davantage produit, mais le travail redevient une contrainte.'); }},
 ],
 'Mines · Champs':[
   {label:'Mobiliser pour les besoins urgents', sub:'− pénurie · effort collectif', can:()=>true, run:()=>{ const c=state.commune; c.stocksCommuns+=c.besoins*0.25; c.penurie=clamp(c.penurie-0.2); c.participation=clamp(c.participation+0.04); pushLog('Mines · Champs','Brigades volontaires : on va chercher l’essentiel là où il manque.'); }},
 ],
 'Quartier ouvrier':[
   {label:'Tenir une assemblée', sub:'++ participation · − bureaucratie', can:()=>true, run:()=>{ const c=state.commune; c.participation=clamp(c.participation+0.18); c.bureaucratie=clamp(c.bureaucratie-0.1); pushLog('Quartier ouvrier','Assemblée de quartier : les décisions se discutent et se votent. La démocratie se réactive.','social'); }},
   {label:'Rotation des tâches', sub:'− bureaucratie durable · − un peu de production', can:()=>true, run:()=>{ const c=state.commune; c.bureaucratie=clamp(c.bureaucratie-0.14); c.planProd=c.planProd*0.96; c.participation=clamp(c.participation+0.06); pushLog('Quartier ouvrier','Rotation des tâches : nul ne se rend indispensable, l’appareil ne se fige pas.','social'); }},
 ],
 'Entrepôt':[
   {label:'Répartir selon les besoins', sub:'− effet de la pénurie · + participation', can:()=>true, run:()=>{ const c=state.commune; c.penurie=clamp(c.penurie-0.16); c.participation=clamp(c.participation+0.05); pushLog('Entrepôt','Distribution selon les besoins : « de chacun selon ses moyens, à chacun selon ses besoins ».','social'); }},
   {label:'Rationner d’en haut', sub:'− pénurie immédiate · + bureaucratie', can:()=>true, run:()=>{ const c=state.commune; c.penurie=clamp(c.penurie-0.26); c.bureaucratie=clamp(c.bureaucratie+0.12); c.participation=clamp(c.participation-0.06); pushLog('Entrepôt','Rationnement décrété d’en haut : efficace dans l’urgence, mais l’appareil décide à la place des gens.','warn'); }},
 ],
 'Marché de vente':[
   {label:'Convertir en maison du peuple', sub:'le marché n’a plus de sens · + participation', can:()=>true, run:()=>{ const c=state.commune; c.participation=clamp(c.participation+0.08); pushLog('Marché de vente','L’ancien marché devient un lieu commun : on n’y vend plus, on s’y réunit.','social'); }},
 ],
 'État · Tribunal':[
   {label:'Démocratie directe', sub:'++ participation · − bureaucratie · plus lent', can:()=>true, run:()=>{ const c=state.commune; c.participation=clamp(c.participation+0.14); c.bureaucratie=clamp(c.bureaucratie-0.12); pushLog('État · Tribunal','Les délégués sont révocables, mandatés, payés au salaire ouvrier : le pouvoir ne se sépare pas de la base.','social'); }},
   {label:'Déléguer à un comité', sub:'décisions rapides · ++ bureaucratie', can:()=>true, run:()=>{ const c=state.commune; c.bureaucratie=clamp(c.bureaucratie+0.16); c.participation=clamp(c.participation-0.1); c.coordination=clamp(c.coordination+0.06); pushLog('État · Tribunal','Un comité tranche vite — mais un appareil séparé de la base commence à se constituer.','warn'); }},
 ],
};
function openCommuneActions(zone){
  const list=COMMUNE_ACTIONS[zone.name];
  document.getElementById('za-title').textContent=displayZoneName(zone.name);
  const left=state.actionsRestantes;
  document.getElementById('za-actions').textContent=left+' action'+(left>1?'s':'')+' restante'+(left>1?'s':'');
  const box=document.getElementById('za-list'); box.innerHTML='';
  if(!list||!list.length){ box.innerHTML='<p style="opacity:.7;font-size:13px">Plus rien à décider ici : ce lieu appartient à l’ancien monde.</p>'; }
  else list.forEach(a=>{ const b=document.createElement('button'); b.className='za';
    const ok=(left>0)&&(!a.can||a.can(state)); b.disabled=!ok;
    b.innerHTML=`<b>${a.label}</b><span class="s">${a.sub}</span>`;
    b.onclick=()=>doCommuneAction(zone,a); box.appendChild(b); });
  document.getElementById('zoneact').classList.add('on'); refreshModalMode(); tutorialCoachRefresh(true);
}
function communeVisual(zoneName,label){
  if(typeof scene==='undefined'||!scene) return;
  const L=(label||'').toLowerCase(), Z=zoneName;
  const BLUE=COL.bleu, GREEN=COL.vert, RED=COL.rouge, GOLD=COL.or;
  const ft=(txt,where,type)=>{ try{ floatText(txt, zonePos(where||Z), type||'social'); }catch(e){} };
  const halo=(n,c)=>{ try{ fxHalo(n,c); }catch(e){} };
  const ping=(n,c)=>{ try{ fxPing(n,c); }catch(e){} };
  const crate=(a,b,c)=>{ try{ fxCrate(a,b,c); }catch(e){} };
  if(L.includes('planifier')){ halo('Usine',BLUE); crate('Quartier ouvrier','Usine',BLUE); ft('plan ↔ besoins','Usine','social'); return; }
  if(L.includes('rendement')){ halo('Usine',RED); ping('Quartier ouvrier',RED); ft('travail contraint','Usine','crise'); return; }
  if(L.includes('mobiliser')){ crate('Mines · Champs','Entrepôt',GREEN); halo('Entrepôt',GREEN); ft('− pénurie','Entrepôt','social'); return; }
  if(L.includes('assemblée')){ halo('Quartier ouvrier',GREEN); ft('+ démocratie','Quartier ouvrier','social'); return; }
  if(L.includes('rotation')){ halo('Quartier ouvrier',GREEN); ft('− appareil','Quartier ouvrier','social'); return; }
  if(L.includes('répartir')){ crate('Entrepôt','Quartier ouvrier',GREEN); halo('Quartier ouvrier',GREEN); ft('selon les besoins','Quartier ouvrier','social'); return; }
  if(L.includes('rationner')){ halo('Entrepôt',GOLD); ping('Quartier ouvrier',RED); ft('+ bureaucratie','Entrepôt','crise'); return; }
  if(L.includes('maison du peuple')){ halo('Marché de vente',GREEN); ft('lieu commun','Marché de vente','social'); return; }
  if(L.includes('démocratie directe')){ halo('État · Tribunal',GREEN); crate('État · Tribunal','Quartier ouvrier',GREEN); ft('pouvoir à la base','État · Tribunal','social'); return; }
  if(L.includes('comité')){ ping('État · Tribunal',RED); halo('État · Tribunal',GOLD); ft('appareil séparé','État · Tribunal','crise'); return; }
  halo(Z,BLUE);
}
function doCommuneAction(zone,a){
  if(state.actionsRestantes<=0 || (a.can&&!a.can(state))) return;
  a.run(); state.actionsRestantes--;
  if(typeof communeVisual==='function') communeVisual(zone.name, a.label);
  if(typeof LWmicro!=='undefined') LWmicro(zone.name);
  renderFormationPanel();
  if(state.actionsRestantes<=0){ document.getElementById('zoneact').classList.remove('on'); refreshModalMode();
    pushLog('Période','Plus d’actions. Résous la période depuis le panneau.','warn'); }
  else openCommuneActions(zone);
}
function resolveCommunePeriod(){
  if(gameOver||anyModalOpen()) return;
  cooldownReal=1.0;
  runCommuneCycle();
  state.actionsRestantes=3; state.commune.an++;
  if(typeof buildSocialTableau==='function') buildSocialTableau();
  renderFormationPanel(); updateConsequences();
  if(checkCommuneEndgame()) return;
  showCommuneReport();
}
function showCommuneReport(){
  const c=state.commune;
  const couv = Math.round(Math.min(1,(c.production+c.stocksCommuns)/Math.max(1,c.besoins))*100);
  const sheet=document.getElementById('report-sheet');
  const row=(k,v,cls)=>`<span class="k">${k}</span><span class="v ${cls||''}">${v}</span>`;
  let lecture;
  if(c.bureaucratie>0.55) lecture='L’appareil se sépare de la base : le danger n’est plus le capital, mais une bureaucratie qui décide à la place des producteurs.';
  else if(c.penurie>0.5) lecture='Sans marché ni profit, ajuster la production aux besoins reste un problème réel : la pénurie use la confiance dans la Commune.';
  else if(c.participation>0.6 && c.penurie<0.3) lecture='Les producteurs associés règlent eux-mêmes la production selon un plan concerté : la liberté commence où cesse le travail contraint.';
  else lecture='La Commune tient, fragile : tout repose sur la participation vivante de la base.';
  sheet.innerHTML=`
    <div class="stamp">Commune · An ${c.an-1}</div>
    <h3>Bilan de la période</h3>
    <p class="verdict ${couv>=90?'ok':(couv>=70?'':'ko')}">Besoins couverts : ${couv} %</p>
    <div class="repsec">Coordination matérielle</div>
    <div class="led compte">
      ${row('Population',Math.round(c.population))}
      ${row('Besoins sociaux',Math.round(c.besoins))}
      ${row('Production',Math.round(c.production))}
      ${row('Réserves communes',Math.round(c.stocksCommuns))}
      ${row('Pénurie',Math.round(c.penurie*100)+' %',c.penurie>0.4?'red':'')}
      ${row('Coordination',Math.round(c.coordination*100)+' %')}
    </div>
    <div class="repsec">Vie politique</div>
    <div class="led">
      ${row('Participation démocratique',Math.round(c.participation*100)+' %',c.participation<0.35?'red':'gold')}
      ${row('Bureaucratie',Math.round(c.bureaucratie*100)+' %',c.bureaucratie>0.5?'red':'')}
    </div>
    <div class="interp"><div class="veilline">Lecture marxienne</div><div>${lecture}</div></div>
    <button class="go" id="report-go">Continuer ▸</button>`;
  document.getElementById('report').classList.add('on');
  document.getElementById('report-go').onclick=()=>{ document.getElementById('report').classList.remove('on'); refreshModalMode(); };
}
function checkCommuneEndgame(){
  const c=state.commune, s=state;
  // dégénérescence bureaucratique
  if(endStreak(s,'cBur', c.bureaucratie>0.7 && c.participation<0.35)>=3){
    endGame({win:false,t:'La révolution confisquée',
      d:'La coordination s’est figée en appareil. Un corps de fonctionnaires décide à la place des producteurs : la propriété privée a disparu, mais la séparation entre dirigeants et dirigés demeure. Ce n’était pas encore le communisme.'}); return true; }
  // effondrement par pénurie prolongée
  if(endStreak(s,'cPen', c.penurie>0.6)>=3){
    endGame({win:false,t:'La Commune s’effondre',
      d:'Faute d’avoir su ajuster la production aux besoins, la pénurie s’est installée. La confiance se délite, chacun se replie : sans abondance ni coordination, la Commune se défait.'}); return true; }
  // la Commune tient : besoins couverts, démocratie vivante, bureaucratie contenue
  const tient = (c.production+c.stocksCommuns)>=c.besoins*0.95 && c.participation>0.6 && c.bureaucratie<0.4 && c.penurie<0.25;
  if(endStreak(s,'cWin', tient)>=4){
    endGame({win:true,t:'La Commune tient',
      d:'Les producteurs associés coordonnent leur travail selon un plan démocratique : les besoins sont couverts, le pouvoir ne s’est pas séparé de la base. L’association libre a remplacé l’accumulation. Le circuit du capital appartient à l’histoire.'}); return true; }
  return false;
}



function startGame(opts={}){
  const handoff=!!opts.handoff;
  // M9 — l'overlay d'intro HTML a été retiré : il était masqué au
  //   démarrage depuis M-Cinéma-b et ne s'affichait donc plus jamais.
  //   On conserve les deux nettoyages défensifs que IntroCinematic.end()
  //   effectuait réellement à chaque démarrage de partie.
  CycleCinematic.clearActors();
  clearTransientCinematicEffects();
  showChantierBtn(false);
  TutorialCoach.active=true; TutorialCoach.minimized=false; TutorialCoach.resetMovement();
  moveTargetMarker(); renderQuest(); renderCircuitBar(); tutorialCoachRefresh(true);
  // M9 — en reprise de sauvegarde, la ligne « Phase 0 » serait un mensonge :
  // la partie restaurée a déjà son propre avancement. chargerPartie() pose
  // son propre message juste après.
  if(opts.resume) return;
  pushLog('Fondation','Quatre cents livres dorment dans un coffre. Le terrain vide, au sud de la grand-rue, attend un atelier.','plain');
}


let activeZone=null, lastTriggered=null, cooldown=0;

/* ============ Gestionnaire d'interface & cohérence du circuit ============ */
const MODAL_IDS=['journal','guide','concept','greve','upgrade','cards','report','zoneact','cycleplay','circuit-info'];
function anyModalOpen(){ return MODAL_IDS.some(id=>{const e=document.getElementById(id); return e&&e.classList.contains('on');}); }
function closeFloatingPanels(){ closeWhap(); const p=document.getElementById('prompt'); if(p) p.classList.remove('on'); }
function refreshModalMode(){
  if(anyModalOpen()){ document.body.classList.add('modal-open'); closeFloatingPanels(); }
  else document.body.classList.remove('modal-open');
  tutorialCoachRefresh();
}
// catégories de zones : A) circuit obligatoire  B) secondaires (si construites)  C) décoratives
const CIRCUIT_ZONES=new Set(CIRCUIT.map(c=>c.zone));
function zoneExists(name){ return zones.some(z=>z.name===name); }
function canInteractWithZone(zone){
  if(!zone || gameOver) return false;
  if(gamePhase==='precapital') return !!precapitalAction(zone.name);
  if(zoneLocked(zone.name)) return false;
  if(CIRCUIT_ZONES.has(zone.name)) return zone.name===CIRCUIT[step].zone;  // seulement l'étape courante
  return false;                                                            // zones secondaires/déco : pas d'action E
}
function getCurrentDestination(){
  if(gamePhase==='precapital') return precapitalTargetZone();
  const c=CIRCUIT[step]; return c?c.zone:null;
}
let QA_MODE=false;
// M1 — fps lissé (moyenne glissante) + dernières métriques renderer.info.
// On échantillonne TOUJOURS, même panneau caché : coût négligeable et le
// panneau affiche des valeurs fraîches dès le premier F3.
let _qaFps=60, _qaAccum=0, _qaCalls=0, _qaTris=0;
function qaSampleFrame(dt){
  if(dt>0){
    const inst = 1/Math.max(1e-4,dt);
    _qaFps = _qaFps*0.92 + inst*0.08;       // EMA, ~constante de temps ~0.4 s
  }
  if(typeof renderer!=='undefined' && renderer && renderer.info){
    _qaCalls = renderer.info.render.calls;
    _qaTris  = renderer.info.render.triangles;
  }
  if(!QA_MODE) return;
  _qaAccum += dt;
  if(_qaAccum >= 0.1){ _qaAccum = 0; updateQA(); }   // panneau rafraîchi à 10 Hz
}
function setQA(on){
  QA_MODE=on;
  document.body.classList.toggle('qa',on);
  if(on){ _qaAccum=0; updateQA(); }
  console.info('[M1] QA panel', on?'ON (F3 toggle)':'OFF');
}
function updateQA(){
  if(!QA_MODE) return;
  const dest=getCurrentDestination();
  const fps    = _qaFps.toFixed(1);
  const calls  = _qaCalls;
  const tris   = _qaTris.toLocaleString('fr-FR');
  const compo  = composer ? (COMPOSER_BYPASS?'bypass':'on') : '—';
  document.getElementById('qa').textContent=
    `fps     : ${fps}  calls: ${calls}  tris: ${tris}\nrender  : ${RENDER_QUALITY}  composer: ${compo}\nphase   : ${gamePhase}\ncycle   : ${state.cycle}  objIndex: ${state.objectifIndex}\nstep    : ${step}  dest: ${dest||'—'}\ndestOK  : ${dest?zoneExists(dest):'—'}\nzone    : ${currentZone?currentZone.name:'—'}  canE: ${canInteractWithZone(currentZone)}\nmodal   : ${anyModalOpen()}  niveauVille: ${state.niveauVille}`;
}
function debugFlow(){
  const dest=getCurrentDestination();
  console.table({ phase:gamePhase, cycle:state.cycle, objectifIndex:state.objectifIndex, step,
    currentDestination:dest, targetBuilt:dest?zoneExists(dest):null,
    canInteract:canInteractWithZone(currentZone), modalOpen:anyModalOpen(),
    activeZone:currentZone?currentZone.name:null });
}
if(typeof window!=='undefined'){ window.debugFlow=debugFlow; window.setQA=setQA; }

function colorFor(type){
  if(type==='crisis') return 'var(--rouge)';
  if(type==='warn') return '#8a6b1f';
  if(type==='social') return 'var(--bleu)';
  return '';
}
function pushLog(title,text,type){
  if(title==='Usine') title='Usine';
  const html=`<b>${title} —</b> ${text}`;
  const col=colorFor(type);
  if(isJournalWorthy(title,text,type)){
    journalEntries.unshift({html, col});
    if(journalEntries.length>120) journalEntries.pop();
  }
  // panneau compact : un seul événement visible, même pour une indication pratique
  const body=document.getElementById('log-body');
  body.innerHTML=`<p${col?` style="color:${col}"`:''}>${html}</p>`;
  if(document.getElementById('journal').classList.contains('on')) renderJournalModal();
}
const ZONE_INFO={
  'Banque':'Le capital est avancé ici (A). C’est le point de départ et de retour du circuit.',
  'Marché des moyens':'On y achète le capital constant : machines et matières (M).',
  'Marché du travail':'On y embauche la force de travail (Ft) — la seule marchandise qui crée de la valeur.',
  'Usine':'Le bâtiment de production (P). Son stade historique peut être atelier, manufacture ou grande industrie.',
  'Entrepôt':'Les marchandises produites s’y entassent (M′) en attendant d’être vendues.',
  'Marché de vente':'M′→A′ : la valeur se réalise en argent. Boucler ici termine le cycle.',
  'Quartier ouvrier':'Là vivent les ouvriers : fatigue, chômage et colère s’y lisent.',
  'État · Tribunal':'L’État légifère, réprime ou concède selon le rapport de force.',
  'Terres communes':'Accumulation primitive : clôturer les communs fabrique des salariés.',
  'Mines · Champs':'Matières premières et rente entrent dans le circuit.',
  'Port · Marché mondial':'Le circuit déborde les frontières : débouchés et matières mondiales.',
  'Bourse':'Capital fictif et spéculation : le risque de crise s’y mesure.',
};
function handleZones(dt){
  refreshModalMode();
  if(QA_MODE) updateQA();
  if(anyModalOpen()){ const p=document.getElementById('prompt'); if(p) p.classList.remove('on'); currentZone=null; return; }
  let inside=null, best=1e9;
  for(const z of zones){
    if(CompetitorWorld.byZone(z.name)&&!CompetitorWorld.revealed) continue;   // v48 : pas encore dans le monde du joueur
    const d2=(Vehicle.pos.x-z.pos.x)**2+(Vehicle.pos.z-z.pos.z)**2;
    z.halo.material.opacity = zoneLocked(z.name) ? 0.08 : 0.22;
    if(d2 < z.radius**2 && d2<best){ inside=z; best=d2; }
  }
  // halo accentué sur le prochain lieu requis
  if(!gameOver){
    const targetName = gamePhase==='precapital' ? precapitalTargetZone() : CIRCUIT[step].zone;
    const nz=zones.find(z=>z.name===targetName);
    if(nz) nz.halo.material.opacity=0.5+0.25*Math.sin(t*3);
  }
  const prompt=document.getElementById('prompt');
  const cardsOpen=document.getElementById('cards').classList.contains('on');
  showLevers(false); // ne s’ouvre plus au simple passage sur le lieu de production
  if(inside){
    // ---- PHASE 0 : prompts de fondation, sur la carte ----
    if(gamePhase==='precapital'){
      const u=precapitalAction(inside.name);
      const lab=precapitalZoneLabel(inside.name);
      prompt.classList.add('on'); currentZone=inside;
      inside.halo.material.opacity=0.62;
      if(u){
        const cost=upgradeCost(u);
        const can=state.argent>=cost;
        prompt.innerHTML=`<b>E</b> — ${precapitalPrompt(u)}`+
          `<small>${lab} · ${cost>0?money(cost):'sans frais'}${can?'':' · argent insuffisant'}</small>`;
      } else {
        const tz=precapitalTargetZone();
        prompt.innerHTML=`${lab}<small>Rien à faire ici pour l’instant${tz?` — prochaine étape : ${precapitalZoneLabel(tz)}`:''}.</small>`;
      }
      return;
    }
    // ---- v48 : FORMATION SOCIALE — prompts explicites (intervenir / observer) ----
    if(typeof gameMode!=='undefined' && gameMode==='socialFormation'){
      prompt.classList.add('on'); currentZone=inside;
      inside.halo.material.opacity=0.62;
      const cf=CompetitorWorld.byZone(inside.name);
      if(cf){
        prompt.innerHTML=`${inside.name} &nbsp;—&nbsp; <b>Appuie sur E pour observer</b><small>${CompetitorWorld.promptInfo(cf)}</small>`;
      } else if(ZONE_ACTIONS[inside.name]){
        prompt.innerHTML=`${displayZoneName(inside.name)} &nbsp;—&nbsp; <b>Appuie sur E pour intervenir</b><small>${zoneInfo(inside.name)||''}</small>`;
      } else {
        prompt.innerHTML=`${displayZoneName(inside.name)}<small>${zoneInfo(inside.name)||'Observe — ou agis ailleurs.'}</small>`;
      }
      return;
    }
    const locked=zoneLocked(inside.name);
    inside.halo.material.opacity = locked ? 0.14 : 0.62;
    if(locked){
      prompt.classList.add('on');
      prompt.innerHTML=`${displayZoneName(inside.name)} &nbsp;—&nbsp; <b>🔒 Débloqué plus tard</b><small>Débloqué par l’accumulation, plus tard dans la partie.</small>`;
      currentZone=inside;
    } else {
      const can = canInteractWithZone(inside);
      const isCircuit = CIRCUIT_ZONES.has(inside.name);
      inside.halo.material.opacity = can ? 0.62 : 0.30;
      prompt.classList.add('on'); currentZone=inside;
      if(can){
        prompt.innerHTML=`${displayZoneName(inside.name)}${inside.key?` (${inside.key})`:''} &nbsp;·&nbsp; <b>étape actuelle</b> &nbsp;—&nbsp; Appuie sur <b>E</b>`+
          `<small>${zoneInfo(inside.name)||''}</small>`;
      } else if(isCircuit){
        const need=CIRCUIT[step];
        prompt.innerHTML=`${displayZoneName(inside.name)}${inside.key?` (${inside.key})`:''}<small>Le circuit passe d’abord par ${displayZoneName(need.zone)} (${need.sym}).</small>`;
      } else {
        prompt.innerHTML=`${displayZoneName(inside.name)}<small>${zoneInfo(inside.name)||'Le circuit ne passe pas par ici.'}</small>`;
      }
    }
  } else {
    prompt.classList.remove('on');
    currentZone=null;
  }
}

/* ===================================================================
   Game  —  boucle principale
   =================================================================== */
let clock;
export function init(opts={}){
  if(opts.environment !== undefined) _bootedEnv = opts.environment;
  buildWorld();
  // M-Peuple-d : initialise le module GLTF AVANT tout placement de figures
  // (Vehicle.build pose le driver, CompetitorWorld.build et populateEnvironment
  // peupleront aussi via spawnFigure). Sans cela, les premiers appels
  // retomberaient sur le stub invisible.
  try{ Peuple.init(); }catch(e){
    console.warn('[M-Peuple] init :', e&&e.message||e);
  }
  CompetitorWorld.build();          // v48 : districts concurrents (cachés jusqu'à la formation sociale)
  Vehicle.build();
  camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,0.1,400);
  camera.position.set(0,16,-44);
  renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(innerWidth,innerHeight);
  renderer.outputColorSpace=THREE.SRGBColorSpace;         // r128 → r16x : tag explicite
  // M1 — couleur de fond renderer alignée sur la brume bleu-encre. Cohérent
  // avec scene.background : pas de flash de papier ancien à l'init.
  renderer.setClearColor(COLORSCRIPT.fogColor, 1.0);
  // M1 — composer + bloom : les émissifs (lampes, fenêtres, verrières,
  // enseignes) débordent dans la brume. Recalibré « Veille du Capital » :
  // strength 0.55 / radius 0.4 / threshold 0.82 (le jour respire à peine,
  // la nuit s'embrase). Puis GradePass : split-tone + vignette + grain.
  // Repli gracieux : si EffectComposer absent, composer reste null et la
  // boucle de rendu retombe sur renderer.render(scene,camera). Zéro erreur.
  if(typeof THREE.EffectComposer!=='undefined' && typeof THREE.UnrealBloomPass!=='undefined'){
    try{
      composer=new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene,camera));
      // M8 — 0.55/0.82 → 0.42/0.86. L'exposition ayant monté, le bloom
      // attrapait trop de surfaces et les transformait en taches saturées.
      bloomPass=new THREE.UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.42,0.4,0.86);
      composer.addPass(bloomPass);
      // M-Cinéma — DoF (BokehPass) inséré APRÈS le bloom, AVANT le grade.
      //   Subtil en jeu (focus lointain, maxblur bas) ; prononcé en mode
      //   cinéma (CinemaMode le pilote en fonction du sujet de la séquence).
      //   Désactivable : si BokehPass absent ou en qualité 'low', bokehPass
      //   reste null et la chaîne saute simplement la passe.
      // M-Cinéma-b/C : DoF OFF PAR DÉFAUT en jeu (zéro flou, zéro coût
      //   d'une passe de profondeur inutile). bokehPass.enabled n'est
      //   passé à true que pendant une séquence cinéma (CinemaMode.begin)
      //   et est REMIS à false dans CinemaMode.end (chemin unique de
      //   sortie : skip + fin naturelle passent par la même fonction).
      if(typeof THREE.BokehPass!=='undefined'){
        try{
          bokehPass=new THREE.BokehPass(scene, camera, {
            focus:    34.0,
            aperture: 0,         // aucune ouverture → aucun flou même si enabled
            maxblur:  0,
          });
          bokehPass.enabled = false;   // DoF désactivé par défaut en jeu
          composer.addPass(bokehPass);
        }catch(err){ console.warn('[M-Cinéma] BokehPass indisponible :', err&&err.message||err); bokehPass=null; }
      }
      if(typeof THREE.ShaderPass!=='undefined'){
        gradePass=new THREE.ShaderPass(GradeShader);
        gradePass.uniforms.uTime.value=0;
        composer.addPass(gradePass);
      }
      composer.setSize(innerWidth,innerHeight);
    }catch(err){
      console.warn('[M1] composer indisponible, bypass propre :', err&&err.message||err);
      composer=null; bloomPass=null; gradePass=null;
    }
  }
  renderer.setPixelRatio(Math.min(1.5,devicePixelRatio)); // v33 : cap léger pour retrouver une conduite fluide
  renderer.toneMapping=THREE.ACESFilmicToneMapping;        // v57 : rendu plus riche, hautes lumières douces
  renderer.toneMappingExposure=1.45;                       // M8 : 1.18 → 1.45, jeu plus lumineux
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  // M1 — qualité par défaut : Haute. Le sélecteur du panneau réglages
  // l'applique à chaud (composer bypass, taille shadowMap, grain).
  applyRenderQuality(RENDER_QUALITY);
  // M0 — IBL : si l'AssetManager a livré une texture équirectangulaire HDR,
  // on compile son PMREM ici (le renderer existe) et on la pose sur la scène
  // avec ENV_INTENSITY = 0.7 (M1 : HDRI = source d'ambiance industrielle).
  if(opts && opts.hdrTexture){
    const pmrem=new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt=pmrem.fromEquirectangular(opts.hdrTexture);
    scene.environment=rt.texture;
    scene.environmentIntensity=ENV_INTENSITY;
    pmrem.dispose();
    opts.hdrTexture.dispose();
  }
  clock=new THREE.Clock();
  buildTargetMarker();
  buildCircuitLine();
  updateHUD(); updateMarx(); renderLeviers();
  renderCircuitBar(); renderQuest(); moveTargetMarker(); updateConsequences();
  updateBuildings(); updateZoneVisibility(); refreshNiveauVille(); updateVilleBadge();
  LivingWorld.init();
  WorldBeauty.init();      // v56
  Atmosphere.init();       // v58 : brume + (anciennement soleil — désormais via SkyAtmo)
  // M2 : SkyAtmo possède le soleil DA (bas-horizon ouest, doré). On efface
  // l'ancien sprite-soleil de Atmosphere pour éviter le double-soleil.
  if(Atmosphere.sun){ Atmosphere.sun.visible=false; }
  PuffTrains.init();       // v63 : bouffées de cheminées
  // M4 — groupage des vitres par zone, liaison flaques↔lampes (lit PUDDLES de M3).
  M4.init(); M4.afterWorld();
  // M-Polish/A — particules & atmosphère (sparks, motes, steam, brume sol).
  //   Initialisé APRÈS M4.afterWorld() : les motes lisent gasLamps[].worldPos.
  try{ M_Polish.init(); }catch(e){ console.warn('[M-Polish/A] init :', e&&e.message||e); }
  // M-Polish/B — micro-vie. Initialisé après populateEnvironment (qui place
  // les cordes à linge taguées) sera fait plus bas après populateEnvironment.
  // le son démarre au premier geste (politique d'autoplay des navigateurs)
  const _sndStart=()=>{ AmbientSound.start(); removeEventListener('pointerdown',_sndStart); removeEventListener('keydown',_sndStart); };
  addEventListener('pointerdown',_sndStart); addEventListener('keydown',_sndStart);
  populateEnvironment();
  // M-Peuple : la population (effectifs par zone × rôle) initialise son
  // pool ici, APRÈS buildWorld (zoneGroups peuplés) et populateEnvironment
  // (figures décoratives placées). Elle ajoute ses propres figures dans
  // chaque zone group, sans .userData.layer — clearLayer ne les touche pas.
  try{ PeuplePop.init(); }catch(e){
    console.warn('[M-Peuple/Pop] init :', e&&e.message||e);
  }
  // M-Polish/B — micro-vie. Initialisé après populateEnvironment pour
  //   pouvoir scanner les cordes à linge taguées (userData.linge) déjà placées.
  try{ M_Life.init(); }catch(e){ console.warn('[M-Polish/B] init :', e&&e.message||e); }
  // M9 — le jeu ne démarre plus tout seul : l'ACCUEIL décide. C'est lui qui
  // lance l'intro cinéma (nouvelle partie) ou la restauration (reprise).
  // Le monde est déjà construit derrière : le joueur choisit devant un
  // paysage qui s'éveille.
  Accueil.ouvrir();
  // M1c — audit one-shot des émissifs après peuplement complet (log console.table)
  try{ auditEmissiveMaterials(); }catch(_){}
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;
    camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);
    if(composer) composer.setSize(innerWidth,innerHeight);});
  loop();
}
let t=0;
/* ---- effets visuels éphémères (phase 0) — pas de mécanique, juste du décor vivant ---- */
let fxList=[];
function zonePos(name){ const z=zones.find(zz=>zz.name===name); return z?z.pos:{x:0,z:0}; }
function fxHalo(name,color){ const p=zonePos(name);
  const ring=new THREE.Mesh(new THREE.RingGeometry(2,3,40),
    new THREE.MeshBasicMaterial({color:(color!=null?color:COL.or),transparent:true,opacity:.75,side:THREE.DoubleSide,depthWrite:false}));
  ring.rotation.x=-Math.PI/2; ring.position.set(p.x,0.12,p.z); scene.add(ring);
  fxList.push({obj:ring,born:t,ttl:1.1,kind:'halo'}); }
function fxPuff(name){ const p=zonePos(name); const grp=new THREE.Group();
  for(let i=0;i<7;i++){ const s=new THREE.Mesh(new THREE.SphereGeometry(0.8,6,6),
    new THREE.MeshStandardMaterial({color:0xb9ad90,transparent:true,opacity:.75,flatShading:true}));
    s.position.set(p.x+(Math.random()*7-3.5),1+Math.random()*2,p.z+(Math.random()*7-3.5)); grp.add(s); }
  scene.add(grp); fxList.push({obj:grp,born:t,ttl:0.9,kind:'puff'}); }
function fxPing(name,color){ const p=zonePos(name);
  const ring=new THREE.Mesh(new THREE.RingGeometry(6,7.2,40),
    new THREE.MeshBasicMaterial({color:(color!=null?color:COL.rouge),transparent:true,opacity:.85,side:THREE.DoubleSide,depthWrite:false}));
  ring.rotation.x=-Math.PI/2; ring.position.set(p.x,0.13,p.z); scene.add(ring);
  fxList.push({obj:ring,born:t,ttl:1.6,kind:'ping'}); }
/* v54 — les marchandises voyagent en CHARIOT, et par la GRAND-RUE.
   Trajet en polyligne : départ -> descendre jusqu'à la rue -> longer la rue -> arriver.
   Vitesse constante (le monde a une matérialité), caisse colorée sur le plateau. */
function fxCrate(fromName,toName,color){
  const a=zonePos(fromName), b=zonePos(toName);
  const cart=createSmallCart();
  const load=box(1.2,1.2,1.2,(color!=null?color:COL.or),0,1.55,0,false); cart.add(load);
  scene.add(cart);
  // polyligne via la rue (z=0) si les points n'y sont pas déjà
  const pts=[{x:a.x,z:a.z}];
  if(Math.abs(a.z)>9) pts.push({x:a.x,z:0});
  if(Math.abs(b.z)>9) pts.push({x:b.x,z:0});
  pts.push({x:b.x,z:b.z});
  let L=0; const cum=[0];
  for(let i=1;i<pts.length;i++){ L+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].z-pts[i-1].z); cum.push(L); }
  fxList.push({obj:cart,born:t,ttl:Math.max(1.6,L/26),kind:'cart',pts,cum,L});
}
function updateFx(){
  for(let i=fxList.length-1;i>=0;i--){ const f=fxList[i]; const k=(t-f.born)/f.ttl;
    if(k>=1){ scene.remove(f.obj); fxList.splice(i,1); continue; }
    if(f.kind==='halo'){ const s=1+k*3; f.obj.scale.set(s,s,s); f.obj.material.opacity=0.75*(1-k); }
    else if(f.kind==='puff'){ f.obj.children.forEach(s=>{ s.position.y+=0.045; if(s.material)s.material.opacity=0.75*(1-k); s.scale.setScalar(1+k); }); }
    else if(f.kind==='ping'){ const s=1+k*0.9; f.obj.scale.set(s,s,s); f.obj.material.opacity=0.85*(1-k); }
    else if(f.kind==='cart'){
      const d=k*f.L; let i=1; while(i<f.cum.length-1 && f.cum[i]<d) i++;
      const a=f.pts[i-1], b=f.pts[i], segL=(f.cum[i]-f.cum[i-1])||1, kk=(d-f.cum[i-1])/segL;
      const x=a.x+(b.x-a.x)*kk, z=a.z+(b.z-a.z)*kk;
      f.obj.position.set(x, 0.04+Math.abs(Math.sin(d*1.7))*0.05, z);     // léger cahot de roulage
      f.obj.rotation.y=Math.atan2(b.x-a.x,b.z-a.z);
    }
  }
}

/* ===================================================================
   TABLEAU SOCIAL — la carte devient le portrait vivant d'une société
   de classes. Restructuré à chaque âge ; reflète les conditions réelles :
   paupérisation (immisération), armée de réserve, Bourses du travail,
   coopératives et secours mutuel, répression d'État, et l'expansion du
   quartier bourgeois. (Références : Marx, Capital I ; histoire ouvrière :
   Bourses du travail 1887+, sociétés de secours mutuel, massacre de
   Fourmies 1891, urbanisme haussmannien de la bourgeoisie.)
   =================================================================== */
let tableauGroup=null;
function tabAdd(m){ if(tableauGroup&&m) tableauGroup.add(m); return m; }
function tabHouse(x,z,kind){
  const g=new THREE.Group();
  if(kind==='riche'){ // hôtel particulier bourgeois : haut, pierre claire, toit mansardé, ornements dorés
    const body=box(4.2,7,4.2,COL.pierre,0,3.5,0); g.add(body);
    const roof=new THREE.Mesh(new THREE.ConeGeometry(3.4,2.4,4), stdMat(0x4a3b2c)); roof.position.set(0,8.2,0); roof.rotation.y=Math.PI/4; g.add(roof);
    g.add(box(4.4,0.4,4.4,COL.or,0,7.05,0));                 // corniche dorée
    g.add(box(0.6,1.4,0.3,COL.or,0,2,2.15));                 // porte cossue
  } else if(kind==='bourse'){ // Bourse du travail : édifice civique ouvrier, fronton, drapeau rouge
    const body=box(6,5,4.5,0x6f6450,0,2.5,0); g.add(body);
    for(let i=-2;i<=2;i++) g.add(box(0.5,3.4,0.5,0xe9ddc6,i*1.2,2.2,2.3)); // colonnade
    g.add(box(6.4,0.7,4.8,0xe9ddc6,0,5.1,0));                // fronton
    const mast=box(0.18,4,0.18,0x33291d,2.6,7,0); g.add(mast);
    g.add(box(1.6,1,0.1,COL.rouge,3.4,8.4,0));               // drapeau rouge
  } else if(kind==='coop'){ // coopérative / secours mutuel : halle basse, enseigne
    const body=box(5,3,3.6,0x7a6a4a,0,1.5,0); g.add(body);
    const roof=box(5.4,0.4,4,COL.brun,0,3.1,0); g.add(roof);
    g.add(box(3,0.8,0.1,COL.vert,0,2.4,1.85));               // bandeau « coopérative »
  } else { // taudis ouvrier : bas, sombre, serré
    const h=2.4+(Math.random()*0.8);
    const body=box(2.6,h,2.6,COL.froid,0,h/2,0); g.add(body);
    const roof=new THREE.Mesh(new THREE.ConeGeometry(2,1.1,4), stdMat(0x4a5763)); roof.position.set(0,h+0.55,0); roof.rotation.y=Math.PI/4; g.add(roof);
  }
  g.position.set(x,0,z); return tabAdd(g);
}
function tabFigure(x,z,color,pose,rotY){
  // M-Peuple-proc : tabFigure produit une figure procédurale via spawnFigure.
  // Mapping pose → type/anim (slump → chomeur idle, strike → ouvrier angry,
  // les gendarmes utilisent un type 'fonctionnaire' implicite via la couleur
  // d'uniforme). La couleur du caller surcharge le vêtement via tint.
  const isGendarme = (color === 0x222c3a);
  const type = isGendarme        ? 'fonctionnaire'
             : pose === 'slump'  ? 'chomeur'
             : 'ouvrier';
  const anim = pose === 'strike' ? 'angry'
             : pose === 'walk'   ? 'walk'
             : 'idle';
  const f = spawnFigure({ type, anim, tint: color });
  f.position.set(x,0,z); if(rotY) f.rotation.y=rotY;
  return tabAdd(f);
}
function buildSocialTableau(){
  if(typeof scene==='undefined'||!scene) return;
  if(gameMode!=='socialFormation' && gameMode!=='commune') return;
  try{
    if(!tableauGroup){ tableauGroup=new THREE.Group(); scene.add(tableauGroup); }
    else { for(let i=(tableauGroup.children?tableauGroup.children.length:0)-1;i>=0;i--) tableauGroup.remove(tableauGroup.children[i]); }
    const s=state, g=s.groups||{}, r=s.regime||{}, age=s.age||1;
    const QO=zonePos('Quartier ouvrier');
    // ---- 1. LA VILLE : la grande industrie suppose la ville ; la carte se densifie par âge ----
    if(age>=3){
      const blocks=Math.min(22, 6+(age-2)*5);                 // de plus en plus dense
      const ring=[ [ -30,-30],[-18,-38],[-6,-44],[10,-42],[22,-34],[34,-22],
                   [40,-6],[42,8],[36,24],[24,36],[8,42],[-8,40],[-22,34],[-34,22],
                   [-40,6],[-38,-10],[18,18],[-18,18],[18,-14],[-14,-18],[0,30],[30,0] ];
      for(let i=0;i<blocks && i<ring.length;i++){ const [bx,bz]=ring[i];
        if(Math.abs(bz)<12) continue;   // v52 : la grand-rue reste dégagée
        const tall=age>=4 ? (2+(i%4)) : 1;
        const blk=box(3.4,3+tall*1.6,3.4, i%3? COL.pierre:0x9c8f74, bx, (3+tall*1.6)/2, bz, false);
        tabAdd(blk);
        if(age>=4 && i%2===0){ const rf=box(3.6,0.5,3.6,COL.brun,bx,3+tall*1.6+0.25,bz,false); tabAdd(rf); }
      }
      // pavé central (la place de la ville)
      const plaza=new THREE.Mesh(new THREE.CircleGeometry(26,40), new THREE.MeshStandardMaterial({color:0xbcae8c,roughness:1}));
      plaza.rotation.x=-Math.PI/2; plaza.position.set(0,0.04,0); tabAdd(plaza);
    }
    // ---- 2. QUARTIER BOURGEOIS : s'enrichit et s'étend avec le capital (urbanisme haussmannien) ----
    const prosp = clamp(capitalProductif(s)/3200 + Math.max(0,s.argent)/4000 + ((s.d&&(s.d.resultatNet||0)>0)?0.15:0));
    const nRiche = Math.round(clamp(prosp)* (age>=5?7:5));
    if(nRiche>0){
      const BX=30, BZ=-78;
      tabAdd(makeLabelMesh('Beaux quartiers', BX, 11, BZ-2));
      for(let i=0;i<nRiche;i++){ const hx=BX-8+(i%4)*5.5, hz=BZ-4+Math.floor(i/4)*6; tabHouse(hx,hz,'riche'); }
      if(prosp>0.5){
        // M-Peuple-d : bourgeois en promenade — melon, posture droite,
        // l'un statique, l'autre qui surveille les passants.
        const b1 = spawnFigure({ type:'bourgeois', anim:'idle', tint:0x6b2f2f });
        b1.position.set(BX-2,0,BZ+5); b1.rotation.y=Math.PI; tabAdd(b1);
        const b2 = spawnFigure({ type:'bourgeois', anim:'idle', tint:0x3a3a55 });
        b2.position.set(BX+2,0,BZ+5); b2.rotation.y=Math.PI; tabAdd(b2);
      }
    }
    // ---- 3. QUARTIER OUVRIER : grandit avec le nombre, s'organise, ou s'enfonce dans la misère ----
    const pop = Math.max(s.travailleurs, Math.round(s.populationActive||s.travailleurs));
    const nTaudis = Math.min(14, Math.round(pop*0.6));
    for(let i=0;i<nTaudis;i++){ const hx=QO.x-10+(i%5)*4.2, hz=QO.z+6+Math.floor(i/5)*4.2; tabHouse(hx,hz,'taudis'); }
    // organisation ouvrière : coopérative puis Bourse du travail
    const org=(g.workers?g.workers.organisation:0), unionF=(g.unions?g.unions.force:0);
    if(org>0.30 || unionF>0.30) tabHouse(QO.x+12, QO.z-2, 'coop');
    if(org>0.45 || unionF>0.45){ tabHouse(QO.x+12, QO.z+8, 'bourse'); }
    // ---- 4. MISÈRE / PAUPÉRISATION : files de pain, bagarres, ouvriers qui s'effondrent ----
    const sat=(g.workers&&g.workers.satisfaction!=null)?g.workers.satisfaction:0.5;
    const penurie=(s.commune?s.commune.penurie:0);
    const misere = clamp(s.colere*0.4 + s.chomage*0.4 + (1-sat)*0.4 + penurie*0.5 - (s.reproSocial||0)*0.05);
    if(misere>0.5){
      // file de pain (figures voûtées en rang) — armée de réserve sans travail
      const n=Math.min(6, 2+Math.round(misere*5));
      for(let i=0;i<n;i++) tabFigure(QO.x-12+i*1.6, QO.z-10, 0x5b5346, 'slump', 0.2);
    }
    if(misere>0.62){
      // bagarre pour le pain
      tabFigure(QO.x+2, QO.z-12, 0x6b5040, 'strike', 1.6);
      tabFigure(QO.x+3.4, QO.z-12, 0x4a4636, 'strike', -1.6);
    }
    if(misere>0.78){
      // mourir de faim : une silhouette à terre
      // M-Peuple-proc : silhouette à terre — type chomeur, anim idle puis
      // rotation Z pour le coucher au sol.
      const fallen = spawnFigure({ type:'chomeur', anim:'idle' });
      fallen.position.set(QO.x-2, 0.4, QO.z-13); fallen.rotation.z=Math.PI/2; tabAdd(fallen);
      tabAdd(makeLabelMesh('La faim', QO.x-2, 3, QO.z-15));
    }
    // ---- 5. RÉPRESSION D'ÉTAT : gendarmes en charge sur le quartier ouvrier ----
    const repress = (r.repression||0);
    if(repress>0.45 || s.modeEtat==='répression'){
      const n=Math.min(4, 1+Math.round(repress*4));
      for(let i=0;i<n;i++){ const f=tabFigure(QO.x+8+i*1.5, QO.z+0, 0x222c3a, 'strike', Math.PI); // gendarmes face aux ouvriers
        if(f){ const baton=box(0.12,1.4,0.12,0x20160e,0.6,1.9,0.3,false); f.add(baton); } }
      tabAdd(makeLabelMesh('Répression', QO.x+10, 4, QO.z-4));
    }
  }catch(e){ /* purement visuel : ne jamais casser le jeu */ }
}
function makeLabelMesh(text,x,y,z){
  try{ const lab=makeLabel(text); lab.scale.set(8,1.6,1); lab.position.set(x,y,z); return tabAdd(lab); }catch(e){ return null; }
}

/* ===================================================================
   MONDE VIVANT  —  couche purement visuelle, réactive à l'état.
   Aucune mécanique économique ici : on ne fait que TRADUIRE l'état
   du moteur en mouvement. Pools réutilisés (jamais d'objet créé par
   frame). « Le capital ne doit plus seulement être calculé : il doit
   circuler sous les yeux du joueur. »
   =================================================================== */
let VISUAL_LIFE = true;
let GRAPHICS_QUALITY = TOUCH ? 'low' : 'medium';   // v67 : un téléphone part en basse qualité   // 'low' | 'medium' | 'high'
function gQual(){ return GRAPHICS_QUALITY==='high'?1.0:GRAPHICS_QUALITY==='low'?0.45:0.75; }

/* --- vocabulaire architectural modulaire + contours gravure --- */
const stdMat=(c,o={})=>new THREE.MeshStandardMaterial(Object.assign({color:c,flatShading:true,roughness:.9,metalness:.02},o));
/* v66 — addOutline NEUTRALISÉE. L'identité « gravure » (contours d'encre sur
   chaque volume) tirait tout le rendu vers le dessin à plat. La nouvelle
   identité « Charbon et lumière » modèle par la LUMIÈRE, pas par la ligne.
   On garde la signature pour ne rien casser : elle ne fait plus rien. */
function addOutline(mesh,color){ return mesh; }
/* v62 — chaque vitre créée s'enregistre : la nuit, DayCycle les allume toutes
   (verre froid le jour -> lueur chaude de lampe à huile la nuit). Chaque fenêtre
   a sa petite personnalité : un déphasage fait qu'elles ne s'allument pas
   exactement ensemble. */
const windowPanes=[];
function createWindow(w=0.8,h=1.0,frame=THEME.ink){ const g=new THREE.Group();
  g.add(box(w+0.18,h+0.18,0.1,frame,0,0,0,false));
  const pane=box(w,h,0.06,0x33414c,0,0,0.05,false);
  pane.material.emissive=new THREE.Color(0x12202a); pane.material.emissiveIntensity=.5;
  pane.userData.glowPhase=Math.random();
  // M4 : on rattache la vitre à la zone en cours de construction (lecture par
  // updateClassLighting pour appliquer la température + densité de classe).
  pane.userData.zone=_M4_currentZone;
  windowPanes.push(pane);
  if(windowPanes.length>520){                                        // purge exacte des vitres démolies
    const vivantes=windowPanes.filter(p=>p.parent);
    windowPanes.length=0; for(const v of vivantes) windowPanes.push(v);
  }
  g.add(pane);
  g.add(box(w,0.06,0.08,frame,0,0,0.08,false)); g.add(box(0.06,h,0.08,frame,0,0,0.08,false)); return g; }
const _glowCold=new THREE.Color(0x12202a), _glowWarm=new THREE.Color(0xffb45e);
function updateWindowGlow(){
  const night=Math.max(0,1-DayCycle.kDay*1.7);            // 0 le jour, 1 la nuit
  if(Vehicle.lampGlass){ Vehicle.lampGlass.material.emissiveIntensity=night*1.2;  // M1c — lampe chariot calibrée
    if(Vehicle.lampPool) Vehicle.lampPool.material.opacity=night*0.5; }
  // M-Peaufinage/A : allumage IRRÉGULIER des fenêtres lointaines.
  //   Chaque fenêtre porte un facteur (glowFactor) et une chance d'être
  //   allumée (litChance), plus une phase de léger scintillement à 0.4 Hz.
  //   Le résultat : pas deux fenêtres identiques, la ville respire.
  const _T = (typeof t !== 'undefined') ? t : 0;
  for(const m of distantGlows){
    const u = m.userData;
    if(!u){ m.emissiveIntensity = night*1.6; continue; }
    if(!u.litChance){ m.emissiveIntensity = 0; continue; }
    const fac = u.glowFactor || 1;
    const flick = 0.85 + 0.15 * Math.sin(_T * 0.4 + u.flickerPh);
    m.emissiveIntensity = night * 1.6 * fac * flick;
  }
  // M4 — baseline night : chaque PointLight reprend SON propre baseI (forge/gold/gas
  // ont des poids différents). updateClassLighting peut ensuite multiplier par
  // un facteur dérivé de la simulation.
  for(const L of nightLights){
    const baseI = (L.userData && L.userData.baseI) || 1.0;
    const classF= (L.userData && L.userData.classFactor!=null) ? L.userData.classFactor : 1.0;
    L.intensity = physI(night * baseI * classF);
  }
  for(const L of gasLamps){                                   // v65 : halos et flaques de gaz
    // M4 — flicker : sinus bruité ±8% (sauf en qualité Basse, où _flickerOff=true)
    let fl = 1.0;
    if(!M4.flickerOff){
      const s = Math.sin(t*6.4 + L.ph) * 0.08
              + Math.sin(t*11.3 + L.flickerSeed) * 0.04;
      fl = 1.0 + s;
    }
    L.halo.material.opacity = night*0.60*fl;
    L.pool.material.opacity = night*0.42*fl;
    if(L.flame && L.flame.material){
      L.flame.material.emissiveIntensity = 0.55 + night*1.20*fl;
    }
    if(L.cone){
      L.cone.material.opacity = night*0.16*fl;
      L.cone.visible = night > 0.02 && !M4.conesOff;
    }
  }
  // M4 — vitres : consulte M4.zoneFx[zone] pour la TEMPÉRATURE (gold/forge/gas/
  // froid) et la DENSITÉ (fraction allumées) propres à chaque classe sociale.
  // Cas non taggé → ancien comportement gas-light.
  const _M4z = M4.zoneFx;
  for(const p of windowPanes){
    if(!p.parent||!p.material) continue;
    const ph = p.userData.glowPhase || 0;
    const zone = p.userData.zone;
    const fx = (zone && _M4z[zone]) ? _M4z[zone] : null;
    if(fx){
      // densité : proportion des fenêtres allumées (decision par phase, déterministe)
      const isOn = (ph < fx.density);
      const on = isOn ? night : 0;
      // pulsation : taux propre à la zone (forge pulse plus vite quand Q monte)
      const puls = fx.pulsAmp ? (1 + fx.pulsAmp*Math.sin(t*fx.pulsHz + ph*9)) : 1;
      p.material.emissive.copy(_glowCold).lerp(fx.color, on);
      p.material.emissiveIntensity = 0.45 + on * fx.intensity * puls;
    } else {
      const on = night*(ph<0.85?1:0.25);                  // legacy : ~15% éteint
      p.material.emissive.copy(_glowCold).lerp(_glowWarm, on);
      p.material.emissiveIntensity = 0.5 + on*(1.6 + 0.5*Math.sin(t*0.8 + ph*9));
    }
  }
}

/* =====================================================================
   M4 — LE COUPLAGE LUMIÈRE/SIMULATION.
   Lecture SEULE de l'état (état + dérivés du dernier cycle). Calcule des
   facteurs lissés exponentiellement (alpha ~ 0.03/frame, ~3 s pour 95%),
   les écrit dans :
     • M4.zoneFx[zone] = { color, density, intensity, pulsHz, pulsAmp }
       (consommé par updateWindowGlow)
     • L.userData.classFactor pour chaque PointLight (multiplie baseI)
   ZÉRO allocation par frame : tous les Color/Vec sont préalloués.
   ===================================================================== */
const M4 = {
  ready:false, conesOff:false, flickerOff:false,
  // États lissés (initialisés en build)
  s_capital: 0.0,     // 0..1 : profit cumulé / SEUIL_CAPITAL
  s_chomage: 0.1,     // 0..1
  s_usineQ:  0.0,     // 0..1 : production normalisée
  s_enclosure: 0.0,   // 0..1 : niveauVille/7
  s_crise: 0.0,       // 0..1 : risqueCrise
  // Pré-alloc : ZÉRO allocation par frame (cf. spec « ZÉRO allocation »).
  _col: {
    gold:  new THREE.Color(0xffd98a),
    forge: new THREE.Color(0xff5a28),
    gas:   new THREE.Color(0xffb45e),
    cold:  new THREE.Color(0xcfd6e4),
  },
  // Pour chaque zone, l'objet fx réutilisé (color, density, intensity, pulsHz, pulsAmp)
  zoneFx: {
    'Banque':           { color:null, density:0.95, intensity:1.9, pulsHz:0.3, pulsAmp:0.10 },
    'Bourse':           { color:null, density:0.95, intensity:1.9, pulsHz:0.3, pulsAmp:0.10 },
    'Usine':            { color:null, density:0.70, intensity:1.6, pulsHz:1.4, pulsAmp:0.45 },
    'Quartier ouvrier': { color:null, density:0.25, intensity:1.4, pulsHz:0.4, pulsAmp:0.15 },
    'État · Tribunal':  { color:null, density:0.30, intensity:1.2, pulsHz:0.2, pulsAmp:0.05 },
    'Terres communes':  { color:null, density:0.00, intensity:1.0, pulsHz:0.2, pulsAmp:0.05 },
    'Mines · Champs':   { color:null, density:0.10, intensity:1.4, pulsHz:0.9, pulsAmp:0.25 },
  },
  zoneWindows: {},                                // groupage des vitres par zone
  puddleReflectors: [],                           // { sprite, lamp }
  init(){
    if(this.ready) return; this.ready=true;
    // initialiser fx.color sur les références préallouées
    this.zoneFx['Banque'].color           = this._col.gold;
    this.zoneFx['Bourse'].color           = this._col.gold;
    this.zoneFx['Usine'].color            = this._col.forge;
    this.zoneFx['Quartier ouvrier'].color = this._col.gas;
    this.zoneFx['État · Tribunal'].color  = this._col.cold;
    this.zoneFx['Terres communes'].color  = this._col.gas;
    this.zoneFx['Mines · Champs'].color   = this._col.forge;
  },
  afterWorld(){
    // groupage des vitres par zone (pour le debug + couplages éventuels)
    for(const p of windowPanes){
      const z = p.userData && p.userData.zone;
      if(!z) continue;
      if(!this.zoneWindows[z]) this.zoneWindows[z]=[];
      this.zoneWindows[z].push(p);
    }
    // reflets dans les flaques : pour chaque flaque, on cherche la lampe à gaz
    // la plus proche (distance < 11 m) et on pose un sprite émissif allongé,
    // additif, opacité 0.30 — pseudo-reflet inversé (façon Stray/Dmitriev).
    const puddles = (typeof window!=='undefined' && window.PUDDLES) || (typeof PUDDLES!=='undefined' ? PUDDLES : []);
    const wp = new THREE.Vector3();
    for(const L of gasLamps){
      L.group.updateWorldMatrix(true,false);
      // on récupère la pos monde du verre (offset (0.68, 3.7, 0) en local)
      const pos = new THREE.Vector3(0.68, 3.7, 0);
      pos.applyMatrix4(L.group.matrixWorld);
      L.worldPos = pos;
    }
    const refTex = this._reflectionTex();
    for(const pu of puddles){
      let best=null, bestD=11*11;
      for(const L of gasLamps){
        if(!L.worldPos) continue;
        const dx=L.worldPos.x-pu.x, dz=L.worldPos.z-pu.z;
        const d2=dx*dx+dz*dz;
        if(d2 < bestD){ bestD=d2; best=L; }
      }
      if(!best) continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: refTex, color: 0xffb45e, transparent:true, opacity:0.0,
        depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      }));
      // reflet allongé verticalement (inversé sous la lampe), légèrement décalé
      const dxs = best.worldPos.x - pu.x;
      const dzs = best.worldPos.z - pu.z;
      sp.scale.set(Math.max(1.0, pu.r*0.6), Math.max(2.2, pu.r*1.6), 1);
      sp.position.set(pu.x + dxs*0.3, 0.035, pu.z + dzs*0.3);
      sp.renderOrder = 1;
      scene.add(sp);
      this.puddleReflectors.push({ sprite:sp, lamp:best });
    }
  },
  _reflectionTex(){
    if(this._refTex) return this._refTex;
    const c=document.createElement('canvas'); c.width=64; c.height=128;
    const x=c.getContext('2d');
    const g=x.createLinearGradient(32, 0, 32, 128);
    g.addColorStop(0,   'rgba(255,200,120,0.85)');
    g.addColorStop(0.4, 'rgba(255,170,90,0.40)');
    g.addColorStop(1,   'rgba(255,150,70,0)');
    x.fillStyle=g; x.fillRect(0,0,64,128);
    // bord latéral atténué
    const gh=x.createRadialGradient(32,64,4,32,64,40);
    gh.addColorStop(0,'rgba(255,255,255,0)'); gh.addColorStop(1,'rgba(0,0,0,0.55)');
    x.globalCompositeOperation='destination-out'; x.fillStyle=gh; x.fillRect(0,0,64,128);
    x.globalCompositeOperation='source-over';
    return this._refTex = new THREE.CanvasTexture(c);
  },
};
function updateClassLighting(dt){
  if(!M4.ready) M4.init();
  if(typeof state==='undefined' || !state) return;
  const night = Math.max(0, 1 - DayCycle.kDay*1.7);          // 0 jour, 1 nuit
  // alpha de lissage : ~3 s pour 95% à 60 fps (alpha 0.02/frame ≈ 1.2 par s)
  const a = Math.min(1, dt*0.4);

  // — entrées simulation (lecture seule, valeurs nulles tolérées) —
  const profit = state.profitCumule || 0;
  const SEUIL  = 8000;                                       // calibrage : argent généreux
  const capitalRaw = Math.max(0, Math.min(1.4, profit/SEUIL));
  const chomageRaw = Math.max(0, Math.min(1, state.chomage||0));
  const niveauV    = state.niveauVille || 0;
  const enclosureRaw = Math.max(0, Math.min(1, niveauV/7, state.enclos ? 0.5 : 0), Math.min(1, niveauV/7));
  const Q         = (state.d && state.d.Q) || 0;
  const usineQRaw = Math.max(0, Math.min(1, Q/200));        // ~200 = pleine production
  const crise     = (state.d && state.d.risqueCrise) || 0;

  // — lissages exponentiels —
  M4.s_capital   += (capitalRaw   - M4.s_capital)   * a;
  M4.s_chomage   += (chomageRaw   - M4.s_chomage)   * a;
  M4.s_enclosure += (enclosureRaw - M4.s_enclosure) * a;
  M4.s_usineQ    += (usineQRaw    - M4.s_usineQ)    * a;
  M4.s_crise     += (crise        - M4.s_crise)     * a;

  // a) BOURSE — intensité ∝ capital accumulé (x1 → x2.2). Halo idem.
  if(M4.zoneFx['Bourse']){ M4.zoneFx['Bourse'].intensity = 1.0 + 1.2 * M4.s_capital; }
  if(M4.zoneFx['Banque']){ M4.zoneFx['Banque'].intensity = 0.9 + 1.0 * M4.s_capital; }

  // b) QUARTIER OUVRIER — densité décroît avec le chômage (25% → 8%)
  if(M4.zoneFx['Quartier ouvrier']){
    M4.zoneFx['Quartier ouvrier'].density = 0.25 - 0.17 * M4.s_chomage;
    // colère/crise → flicker plus marqué (l'angoisse vacille)
    M4.zoneFx['Quartier ouvrier'].pulsAmp = 0.10 + 0.20*M4.s_crise;
  }

  // c) USINE — verrières pulsent + rouges quand la production tourne, presque
  //    éteintes à l'arrêt.
  if(M4.zoneFx['Usine']){
    const fx = M4.zoneFx['Usine'];
    fx.density   = 0.10 + 0.65 * M4.s_usineQ;                // de 10% à 75% allumées
    fx.intensity = 0.6 + 1.2 * M4.s_usineQ;
    fx.pulsHz    = 0.7 + 2.0 * M4.s_usineQ;                  // pulse plus vite à plein régime
    fx.pulsAmp   = 0.15 + 0.40 * M4.s_usineQ;
  }

  // d) TERRES COMMUNES — lueur résiduelle s'éteint avec l'enclosure
  if(M4.zoneFx['Terres communes']){
    M4.zoneFx['Terres communes'].density = Math.max(0, 0.18 * (1 - M4.s_enclosure));
  }

  // — PointLights : classFactor multiplie baseI selon le rôle —
  for(const c of classLights){
    let f = 1.0;
    if(c.role === 'gold'){
      f = 0.85 + 1.10 * M4.s_capital;                        // x0.85 → x1.95
    } else if(c.role === 'forge'){
      // usine : pleine production = forge éclatante. mines : plus stable.
      if(c.zone === 'Usine')      f = 0.30 + 1.40 * M4.s_usineQ;
      else                        f = 0.85 + 0.30 * M4.s_usineQ;
    } else if(c.role === 'gas'){
      f = 1.00;
    } else if(c.role === 'gas-reserve'){
      // réserve : Quartier vacille avec colère, Port stable
      if(c.zone === 'Quartier ouvrier') f = 0.70 - 0.30*M4.s_chomage + 0.20*Math.sin(t*1.4);
      else                              f = 1.00;
    }
    c.light.userData.classFactor = f;
  }

  // — M5 — peau de la BOURSE : bandeau cotations défile + girouette tourne +
  //   verrière dorée pulse ∝ capital (intensité émissive de matVerriere).
  if(_M5_cotationsTex){ _M5_cotationsTex.offset.x = (-t*0.06) % 1; }
  if(_M5_bourseCoin){ _M5_bourseCoin.rotation.z = t*0.12; }
  // pousse l'intensité émissive de la verrière dorée — toucher 1 material seulement
  // (tag m4Role='bourse-verriere' posé en build). On scanne la scène une seule fois.
  if(!M4._bourseMats){
    M4._bourseMats=[]; M4._etatMats=[];
    scene.traverse(o=>{
      if(o.material && o.material.userData){
        if(o.material.userData.m4Role==='bourse-verriere'){
          if(!M4._bourseMats.includes(o.material)) M4._bourseMats.push(o.material);
        } else if(o.material.userData.m4Role==='etat-horloge'){
          if(!M4._etatMats.includes(o.material)) M4._etatMats.push(o.material);
        }
      }
    });
  }
  for(const m of M4._bourseMats){
    m.emissiveIntensity = 1.2 + 1.4*M4.s_capital + 0.10*Math.sin(t*0.6);
  }
  for(const m of M4._etatMats){
    m.emissiveIntensity = 1.10 + 0.06*Math.sin(t*0.35);   // stable, presque imperturbable
  }

  // — REFLETS DANS LES FLAQUES — opacité suit la nuit + flicker de la lampe associée.
  if(!M4.conesOff){
    for(const r of M4.puddleReflectors){
      // re-use la phase de flicker de la lampe (même que dans updateWindowGlow)
      const L = r.lamp;
      let fl = 1.0;
      if(!M4.flickerOff){
        fl = 1 + Math.sin(t*6.4 + L.ph)*0.08 + Math.sin(t*11.3 + L.flickerSeed)*0.04;
      }
      r.sprite.material.opacity = night * 0.30 * fl;
      r.sprite.visible = night > 0.02;
    }
  } else {
    for(const r of M4.puddleReflectors){ r.sprite.visible=false; }
  }
}

/* M4 — sélecteur qualité : Basse coupe les cônes, reflets, flicker.
   PointLights réduites à 4 prioritaires (banque, usine, 2 rues clés). */
function _applyM4Quality(q){
  const low = (q === 'low');
  M4.conesOff = low;
  M4.flickerOff = low;
  // coupe les sprites-reflets
  for(const r of M4.puddleReflectors){ if(low) r.sprite.visible=false; }
  // PointLights : conserve seulement 4 essentielles en Basse.
  const KEEP_LOW = new Set(['Bourse', 'Usine', 'rue-centre-ouest', 'rue-centre-est']);
  for(const c of classLights){
    if(low) c.light.visible = KEEP_LOW.has(c.zone);
    else    c.light.visible = true;
  }
  // cônes : la visibilité est aussi gérée par updateWindowGlow (M4.conesOff).
}
if(typeof window!=='undefined') window._applyM4Quality=_applyM4Quality;

/* M1c — AUDIT ÉMISSIFS. Parcourt la scène, recense les matériaux émissifs
   ou très clairs, calcule une luminance approximative (Rec.709 * intensité)
   et signale ceux qui dépasseraient le threshold du bloom (M8 : 0.86).
   One-shot à l'init + accessible en console : window.auditEmissiveMaterials().
   Charte M1c : seuls peuvent fleurir lampes/flammes, fenêtres émissives, soleil
   et marqueurs d'objectif ponctuels. Tout guidage permanent étendu reste
   strictement sous le threshold (peinture au sol, pas néon). */
function auditEmissiveMaterials(){
  if(typeof scene==='undefined' || !scene){ console.warn('[M1c] audit : scène absente'); return []; }
  const THRESH=(bloomPass && typeof bloomPass.threshold==='number') ? bloomPass.threshold : 0.82;
  const rows=[]; const seen=new Set();
  const ownerName=o=>{
    let n=[]; let cur=o;
    while(cur && n.length<3){ if(cur.name) n.push(cur.name); else if(cur.userData&&cur.userData.layer) n.push('@'+cur.userData.layer); cur=cur.parent; }
    return n.length?n.join('/'):o.type||'mesh';
  };
  scene.traverse(o=>{
    if(!o||!o.material) return;
    const mats=Array.isArray(o.material)?o.material:[o.material];
    for(const m of mats){
      if(!m||seen.has(m.uuid)) continue; seen.add(m.uuid);
      const eI=(typeof m.emissiveIntensity==='number')?m.emissiveIntensity:0;
      const eHex=m.emissive?('#'+m.emissive.getHexString()):'-';
      const cHex=m.color?('#'+m.color.getHexString()):'-';
      // luminance Rec.709 de la couleur émissive (linéaire 0-1) * intensité
      let lum=0;
      if(m.emissive && eI>0){
        lum=(0.2126*m.emissive.r + 0.7152*m.emissive.g + 0.0722*m.emissive.b)*eI;
      }
      // luminance approx de la couleur diffuse (info, ne déclenche pas le bloom seule)
      let lumDiff=0;
      if(m.color){ lumDiff=0.2126*m.color.r + 0.7152*m.color.g + 0.0722*m.color.b; }
      if(eI<=0 && lumDiff<0.78) continue;       // ni émissif, ni très clair : on ignore
      rows.push({
        owner: ownerName(o),
        emissive: eHex,
        intensity: +eI.toFixed(3),
        emissiveLum: +lum.toFixed(3),
        color: cHex,
        diffuseLum: +lumDiff.toFixed(3),
        bloomsLikely: (lum>THRESH)?'YES':'no',
      });
    }
  });
  rows.sort((a,b)=>b.emissiveLum-a.emissiveLum);
  const overs=rows.filter(r=>r.bloomsLikely==='YES');
  console.groupCollapsed('[M1c] Audit émissifs · '+rows.length+' matériaux · threshold = '+THRESH.toFixed(2)+' · '+overs.length+' au-dessus');
  console.table(rows);
  if(overs.length) console.info('[M1c] Au-dessus du threshold (peuvent fleurir) :', overs.map(r=>r.owner+' @'+r.intensity).join(' · '));
  console.groupEnd();
  return rows;
}
if(typeof window!=='undefined') window.auditEmissiveMaterials=auditEmissiveMaterials;
function createDoor(w=1.6,h=2.6,c=0x281f17){ const g=new THREE.Group();
  g.add(box(w+0.24,h+0.18,0.12,COL.brun,0,h/2,0,false));
  const dr=box(w,h,0.12,c,0,h/2,0.06,false); dr.material.map=texWood(); g.add(dr);
  g.add(box(0.13,0.13,0.16,COL.or,w*0.3,h*0.5,0.12,false)); return g; }
function createColumn(h=7,r=0.5){ const g=new THREE.Group();
  const sh=cyl(r,r*1.08,h,COL.pierre,12); sh.position.y=h/2; g.add(sh);
  g.add(box(r*2.7,0.45,r*2.7,0xdcd1b0,0,h+0.1,0,false));
  g.add(box(r*2.9,0.45,r*2.9,0xb8a986,0,0.22,0,false)); return g; }
function createSteps(w=11,n=3){ const g=new THREE.Group();
  for(let i=0;i<n;i++) g.add(box(w-i*1.4,0.42,3.4-i*0.7,0xb8a986,0,0.21+i*0.42,3.4-i*0.4,false)); return g; }
function createRoof(type,w,d,c=0x46393b){ const g=new THREE.Group();
  if(type==='pitched'){ const half=w/2, rise=2.1, len=Math.hypot(half,rise), slope=Math.atan2(rise,half);
    const a=box(len,0.26,d,c,-half/2,rise/2,0,false); a.rotation.z=slope; g.add(a);
    const b=box(len,0.26,d,c, half/2,rise/2,0,false); b.rotation.z=-slope; g.add(b);
    g.add(box(0.22,0.22,d+0.2,THEME.ink,0,rise,0,false)); }
  else if(type==='sawtooth'){ const n=Math.max(2,Math.floor(w/3.2));
    for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*(w/n);
      g.add(box(w/n*0.5,1.9,d,c,x-w/n*0.22,0.95,0,false));
      const gl=box(w/n*0.62,1.7,d*0.98,0x33414c,x+w/n*0.18,1.05,0,false); gl.rotation.z=-0.66; gl.material.emissive=new THREE.Color(0x14222c); g.add(gl); } }
  else { g.add(box(w,0.32,d,c,0,0.16,0,false)); }
  return g; }
function createSign(text){
  const lab=makeLabel(text); lab.scale.set(6,1.5,1);
  // M-Peaufinage/D : tous les signes £, P, A', M, M', Ft, ÉTAT, numéros
  //   d'arches… deviennent transparents quand on s'en approche.
  lab.userData.zoneSign = true; _zoneSigns.push(lab);
  return lab;
}
function createAwning(w=4,c=COL.rouge){ const g=new THREE.Group();
  const a=box(w,0.18,2.2,c,0,0,0,false); a.rotation.x=0.2; g.add(a);
  for(let i=0;i<Math.max(2,Math.floor(w));i++){ const s=new THREE.Mesh(new THREE.ConeGeometry(0.34,0.5,3),stdMat(c));
    s.rotation.x=Math.PI; s.position.set(-w/2+0.5+i,-0.22,1.02); g.add(s); } return g; }
function createDock(w=12,d=6,h=0.8){ const g=new THREE.Group();
  const slab=box(w,h,d,0x8d7c58,0,h/2,0,false); slab.material.map=texWood(); g.add(slab);
  for(let x=-w/2+0.7;x<w/2;x+=2.2) g.add(box(0.3,h+0.5,0.3,COL.brun,x,(h+0.5)/2,d/2-0.3,false)); return g; }
function createPipe(len=5){ return createFactoryPipe(len); }
function createFence(len=4){ return createFenceSegment(len); }
function createPoster(text){ return createPosterBoard(text); }

/* --- objets modulaires réutilisables --- */
/* =====================================================================
   M7 — PROPS HABILLÉS (Lot C).
   Toute caisse / tonneau / sac / charrette / lampadaire des zones et de
   l'habillage récupère ici de la profondeur de construction : planches,
   clous, cerclages, douves, étoffe liée, roues à rayons, fûts moulurés.
   Plus aucun cube nu, plus aucune sphère verte plate.
   ===================================================================== */
function _M7_stencilTex(label){
  const c=document.createElement('canvas'); c.width=128; c.height=64;
  const x=c.getContext('2d');
  x.clearRect(0,0,128,64);
  x.font='700 22px "IBM Plex Mono", monospace';
  x.textAlign='center'; x.textBaseline='middle';
  x.fillStyle='rgba(28,20,14,0.85)';
  x.fillText(label, 64, 30);
  x.strokeStyle='rgba(28,20,14,0.75)'; x.lineWidth=2;
  x.strokeRect(8, 12, 112, 40);
  // 2 petites étoiles aux coins (douanes/marquage)
  for(const cx of [16, 112]){
    x.fillStyle='rgba(28,20,14,0.7)';
    x.beginPath(); x.arc(cx, 32, 3, 0, Math.PI*2); x.fill();
  }
  return new THREE.CanvasTexture(c);
}
const _M7_STENCIL_POOL=['LONDON','MARCH','BRADFORD','STEAM','EAST INDIA','LEEDS','MANCHESTER','£CO'];
function createCrate(size=1.5, color=0x8a5a3e){
  const g=new THREE.Group();
  const matBois=new THREE.MeshStandardMaterial({color, map:texWood(), roughness:0.95, metalness:0, flatShading:true});
  const matBoisFonce=new THREE.MeshStandardMaterial({color:0x5a3a25, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  // corps
  const body=new THREE.Mesh(new THREE.BoxGeometry(size, size*0.95, size), matBois);
  body.position.y=size*0.5; body.castShadow=true; body.receiveShadow=true;
  g.add(body);
  // planches verticales en relief sur la face avant (z=+)
  for(let i=0; i<3; i++){
    const plank=new THREE.Mesh(new THREE.BoxGeometry(size*0.28, size*0.92, 0.04), matBoisFonce);
    plank.position.set(-size*0.32 + i*size*0.32, size*0.5, size*0.51);
    g.add(plank);
  }
  // bandeaux fer croisés (X)
  g.add(_M7_fastBox(size*1.04, size*0.06, 0.06, matFer, 0, size*0.50, size*0.53, false));
  g.add(_M7_fastBox(0.06, size*0.06, size*1.04, matFer, 0, size*0.50, 0, false));
  // clous aux 4 coins de la face avant
  for(const sx of [-1, 1]) for(const sy of [-1, 1]){
    const nail=new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4), matFer);
    nail.position.set(sx*size*0.42, size*0.5 + sy*size*0.38, size*0.54);
    g.add(nail);
  }
  // estampille canvas (label aléatoire du pool)
  const label=_M7_STENCIL_POOL[Math.floor(Math.random()*_M7_STENCIL_POOL.length)];
  const stencil=new THREE.Mesh(new THREE.PlaneGeometry(size*0.55, size*0.22),
    new THREE.MeshStandardMaterial({map:_M7_stencilTex(label), transparent:true, roughness:0.95, side:THREE.DoubleSide}));
  stencil.position.set(0, size*0.62, size*0.55);
  g.add(stencil);
  return g;
}
function _M7_fastBox(w, h, d, mat, x, y, z, castShadow=true){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow=castShadow; m.receiveShadow=true;
  return m;
}
/* ouvrier articulé low-poly — compatible avec les pools (userData.head pour le bob) */
/* M-Peuple-proc : l'ancien système procédural (createWorkerFigure /
   createDetailedWorker / setWorkerPose / animateWorker) a été supprimé.
   Le nouveau module Peuple (figures stylisées construites à la main) est
   la seule population du monde. tabFigure est conservé en helper et route
   vers spawnFigure avec mapping pose→type/anim. */
function createSmokeStack(h=11,color=COL.charbon){
  const g=new THREE.Group(); g.add(box(1.8,h,1.8,color,0,h/2,0));
  g.add(box(2.2,0.6,2.2,COL.fer,0,h,0,false)); return g;
}
function createLedgerSign(text){ return makeLabel(text); }
function createRailSegment(len=6){
  const g=new THREE.Group();
  for(const off of[-0.6,0.6]) g.add(box(0.22,0.16,len,0x4a4236,off,0.2,0,false));
  for(let k=0;k<=Math.floor(len/3);k++) g.add(box(2,0.16,0.4,0x5a4a36,0,0.18,-len/2+k*3,false));
  return g;
}
function createPriceBoard(text='£'){
  const c=document.createElement('canvas'); c.width=128; c.height=160; const x=c.getContext('2d');
  x.fillStyle='#e9ddc6'; x.fillRect(0,0,128,160);
  x.strokeStyle='#241f17'; x.lineWidth=6; x.strokeRect(5,5,118,150);
  x.fillStyle='#8a2c1d'; x.font='700 60px "IBM Plex Mono",monospace';
  x.textAlign='center'; x.textBaseline='middle'; x.fillText(text,64,86);
  const tex=new THREE.CanvasTexture(c); const g=new THREE.Group();
  g.add(box(0.25,3,0.25,COL.brun,0,1.5,0,false));
  const b=new THREE.Mesh(new THREE.PlaneGeometry(2.2,2.7),
    new THREE.MeshBasicMaterial({map:tex,transparent:true,side:THREE.DoubleSide}));
  b.position.set(0,3.3,0); g.add(b); return g;
}
function createDebtThread(){
  const a=zonePos('Banque'), b=zonePos('Usine');
  const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz)||1;
  const m=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.16,len,6),
    new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:0,depthWrite:false}));
  m.position.set((a.x+b.x)/2,7,(a.z+b.z)/2);
  const dir=new THREE.Vector3(dx,0,dz).normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir);
  m.visible=false; return m;
}

/* ===================================================================
   DIORAMA DENSE — librairie de props + peuplement des zones.
   Tout en primitives + CanvasTexture, regroupé dans un seul Group,
   gated par gamePhase / niveauVille / DETAIL_LEVEL. Aucune collision
   ajoutée : le décor n'entrave jamais la conduite (les objets légers
   se laissent bousculer). « Avoir envie de rouler avant de comprendre. »
   =================================================================== */
let DETAIL_LEVEL=TOUCH?'medium':'high';   // v67 : décor plus léger au doigt                 // 'low' | 'medium' | 'high'
function dDen(){ return DETAIL_LEVEL==='high'?1:DETAIL_LEVEL==='medium'?0.65:0.35; }

/* --- textures procédurales sobres (gravure / registre) --- */
let _tx={};
function texWood(){ if(_tx.wood)return _tx.wood; const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');
  x.fillStyle='#7a5a39';x.fillRect(0,0,128,128);
  x.strokeStyle='rgba(40,28,16,0.45)';x.lineWidth=2; for(let i=10;i<128;i+=20){x.beginPath();x.moveTo(0,i);x.lineTo(128,i);x.stroke();}
  x.strokeStyle='rgba(40,28,16,0.18)';x.lineWidth=1; for(let i=0;i<50;i++){const y=Math.random()*128;x.beginPath();x.moveTo(0,y);x.lineTo(128,y+Math.random()*4-2);x.stroke();}
  const t=new THREE.CanvasTexture(c);_tx.wood=t;return t; }
function texMetal(){ if(_tx.metal)return _tx.metal; const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');
  x.fillStyle='#4b4a45';x.fillRect(0,0,128,128);
  x.strokeStyle='rgba(20,18,15,0.4)';x.lineWidth=1; for(let i=0;i<128;i+=6){x.beginPath();x.moveTo(i,0);x.lineTo(i,128);x.stroke();}
  x.fillStyle='rgba(255,240,210,0.05)'; for(let i=0;i<30;i++)x.fillRect(Math.random()*128,Math.random()*128,2,8);
  const t=new THREE.CanvasTexture(c);_tx.metal=t;return t; }
function texBrick(){ if(_tx.brick)return _tx.brick; const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');
  x.fillStyle='#6e5640';x.fillRect(0,0,128,128); x.strokeStyle='rgba(30,22,14,0.5)';x.lineWidth=2;
  for(let r=0;r<128;r+=16){ x.beginPath();x.moveTo(0,r);x.lineTo(128,r);x.stroke();
    const off=(r/16)%2?8:0; for(let cc=off;cc<128;cc+=24){x.beginPath();x.moveTo(cc,r);x.lineTo(cc,r+16);x.stroke();} }
  const t=new THREE.CanvasTexture(c);_tx.brick=t;return t; }

const cyl=(r1,r2,h,c,seg=12)=>new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,h,seg),
  new THREE.MeshStandardMaterial({color:c,flatShading:true,roughness:.85}));

/* --- props (ceux non déjà définis ailleurs) --- */
function createBarrel(c=0x5a4530){
  const g=new THREE.Group();
  const matBois=new THREE.MeshStandardMaterial({color:c, map:texWood(), roughness:0.95, metalness:0, flatShading:true});
  const matBoisFonce=new THREE.MeshStandardMaterial({color:0x3a2818, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x2c2113, roughness:0.5, metalness:0.7, flatShading:true});
  // douves : cylindre principal avec radius légèrement supérieur en milieu
  // pour le bombement caractéristique du tonneau (3 cylindres empilés).
  const lower=new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.50, 0.42, 14), matBois);
  lower.position.y=0.22; lower.castShadow=true; g.add(lower);
  const middle=new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.50, 14), matBois);
  middle.position.y=0.66; middle.castShadow=true; g.add(middle);
  const upper=new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.55, 0.42, 14), matBois);
  upper.position.y=1.10; upper.castShadow=true; g.add(upper);
  // 3 cerclages fer
  for(const y of [0.30, 0.66, 1.02]){
    const band=new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.08, 14), matFer);
    band.position.y=y; g.add(band);
  }
  // fond + couvercle (disques)
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.04, 14), matBoisFonce)).position.y=0.02;
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.04, 14), matBoisFonce)).position.y=1.31;
  // bouchon central (petit cylindre saillant)
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.06, 8), matBoisFonce)).position.y=1.35;
  return g;
}
function createSack(c=0xc9b78c){
  const g=new THREE.Group();
  const matToile=new THREE.MeshStandardMaterial({color:c, roughness:1.0, metalness:0, flatShading:true});
  const matCorde=new THREE.MeshStandardMaterial({color:0x4a3a22, roughness:0.95, metalness:0, flatShading:true});
  // corps : sphère déformée allongée
  const body=new THREE.Mesh(_M7_deformedSphere(0.50, 8, 17, 0.14, 1.0, 1.30, 1.0), matToile);
  body.position.y=0.60; body.castShadow=true; body.receiveShadow=true;
  g.add(body);
  // pli côté avant (planche sombre suggérée par 2 boxes verticales)
  g.add(_M7_fastBox(0.04, 0.55, 0.03, matCorde, -0.15, 0.55, 0.45, false));
  g.add(_M7_fastBox(0.04, 0.55, 0.03, matCorde, 0.15, 0.55, 0.45, false));
  // corde wrap autour du sommet (torus)
  const cord=new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.04, 4, 12), matCorde);
  cord.rotation.x=Math.PI/2; cord.position.y=1.05;
  g.add(cord);
  // chignon noué au-dessus
  const knot=new THREE.Mesh(new THREE.SphereGeometry(0.20, 7, 5), matToile);
  knot.scale.set(1.0, 0.70, 1.0); knot.position.y=1.18;
  g.add(knot);
  // petite mèche tombante
  g.add(_M7_fastBox(0.04, 0.25, 0.04, matCorde, 0.18, 1.22, 0.05, false)).rotation.z=0.3;
  return g;
}
function createCoalPile(){ const g=new THREE.Group();
  const m=new THREE.Mesh(new THREE.ConeGeometry(1.6,1.3,7),new THREE.MeshStandardMaterial({color:THEME.darkBrown,flatShading:true,roughness:1}));
  m.position.y=0.65; g.add(m);
  for(let i=0;i<5;i++){ const r=new THREE.Mesh(new THREE.SphereGeometry(0.24,5,4),new THREE.MeshStandardMaterial({color:0x1d1610,flatShading:true}));
    r.position.set(Math.random()*2.4-1.2,0.2,Math.random()*2.4-1.2); g.add(r); } return g; }
function createCrateStack(){ const g=new THREE.Group();
  [[0,0,0],[1.08,0,0],[0,0,1.08],[1.08,0,1.05],[0.54,1.05,0.5]].forEach((p,i)=>{
    const m=box(1,1,1,i%2?0x8a6b49:0x77593b,p[0],0.5+p[1],p[2],false); m.material.map=texWood(); m.rotation.y=Math.random()*0.2-0.1; g.add(m); }); return g; }
function createBrokenCrate(){ const g=new THREE.Group();
  g.add(box(1,0.55,1,0x77593b,0,0.28,0,false));
  const p=box(1,0.12,0.4,0x5a4530,0.2,0.66,0.1,false); p.rotation.z=0.5; g.add(p);
  const q=box(0.4,0.12,1,0x5a4530,-0.2,0.6,-0.1,false); q.rotation.x=0.4; g.add(q); return g; }
function createCrisisCrack(){ const g=new THREE.Group();
  const seg=(x,z,a,l)=>{ const m=box(l,0.04,0.16,THEME.crisis,x,0.06,z,false); m.rotation.y=a; g.add(m); };
  seg(0,0,0.3,3); seg(1.2,0.6,-0.6,2.2); seg(-1,0.5,0.9,2); seg(0.4,-1,1.5,1.6); return g; }
/* v65 — le réverbère devient une LAMPE À GAZ complète : potence ouvragée,
   verre, HALO de lumière (sprite) et FLAQUE de lumière chaude au sol —
   les deux pilotés par la nuit. La ville nocturne se lit par ses lampes. */
let _gasHaloTex=null,_gasPoolTex=null;
function _gasTextures(){
  if(_gasHaloTex) return;
  const mk=(stops,h)=>{ const c=document.createElement('canvas'); c.width=c.height=128;
    const x=c.getContext('2d'); const g=x.createRadialGradient(64,64,2,64,64,62);
    stops.forEach(([k,col])=>g.addColorStop(k,col)); x.fillStyle=g; x.fillRect(0,0,128,128);
    return new THREE.CanvasTexture(c); };
  _gasHaloTex=mk([[0,'rgba(255,196,110,0.85)'],[0.35,'rgba(255,178,86,0.30)'],[1,'rgba(255,178,86,0)']]);
  _gasPoolTex=mk([[0,'rgba(255,190,104,0.50)'],[1,'rgba(255,190,104,0)']]);
}
const gasLamps=[];
/* =====================================================================
   M4 — LA LUMIÈRE DE CLASSE.
   Allocation STRICTE de 10 PointLights, 3 températures fixes :
     • goldLight  0xffd98a (finance)   — Banque, Bourse
     • forgeLight 0xff5a28 (industrie) — Usine, Mines
     • gasLight   0xffb45e (rue/commun)— 4 lampadaires clés + 2 réserve scénique
   Distance bornée, decay 2, pas de chevauchement. Le reste du « néon » est
   émissif + faux volumes (cônes, halos, reflets dans les flaques).
   Le tableau nightLights[] héberge les PointLights ; classLights[] indexe
   par rôle (zone) pour le couplage simulation→lumière.
   ===================================================================== */
const nightLights=[];
const classLights=[];                       // { role, zone, light, baseI, color }
function buildNightLights(){
  const ALLOC=[
    // role, zone,                 x,    y,  z,  color,          baseI, dist
    ['gold','Banque',              -72,  7, -22, 0xffd98a,        1.20, 28],
    ['gold','Bourse',              -72,  8, -56, 0xffd98a,        1.40, 30],
    ['forge','Usine',              -15,  6,  28, 0xff5a28,        1.50, 30],
    ['forge','Mines · Champs',    -105,  6, -58, 0xff5a28,        1.20, 28],
    ['gas','rue-ouest',            -60,  5,   0, 0xffb45e,        0.95, 26],
    ['gas','rue-centre-ouest',     -20,  5,   0, 0xffb45e,        0.95, 26],
    ['gas','rue-centre-est',        20,  5,   0, 0xffb45e,        0.95, 26],
    ['gas','rue-est',               70,  5,   0, 0xffb45e,        0.95, 26],
    ['gas-reserve','Quartier ouvrier', 0,5,  56, 0xffb45e,        0.85, 24],
    ['gas-reserve','Port · Marché mondial', 95, 6, 2, 0xffb45e,   0.85, 24],
  ];
  for(const [role, zone, x, y, z, color, baseI, dist] of ALLOC){
    const L=new THREE.PointLight(color, 0, dist, 2);
    L.position.set(x,y,z);
    L.userData.role=role;
    L.userData.zone=zone;
    L.userData.baseI=baseI;
    scene.add(L);
    nightLights.push(L);
    classLights.push({role, zone, light:L, baseI, color});
  }
}
/* createLampPost — lampadaire à gaz : poteau, potence, cage, verre émissif (la
   FLAMME, qui nourrit le bloom), halo sprite + mare au sol additif, cône de
   lumière additif sous la lanterne. Tous tracés enregistrés dans gasLamps[]
   pour que updateWindowGlow / updateClassLighting / _applyM4Quality les pilotent. */
function createLampPost(){ const g=new THREE.Group(); _gasTextures();
  // M7 — fût mouluré en fonte : socle carré + 3 anneaux + chapiteau juste sous
  // la potence. Le poteau cylindrique remplace la box plate originale.
  const matFonte=new THREE.MeshStandardMaterial({color:0x1c1814, roughness:0.5, metalness:0.7, flatShading:true});
  // socle bas carré (plinthe en fonte)
  g.add(_M7_fastBox(0.40, 0.28, 0.40, matFonte, 0, 0.14, 0, false));
  // base saillante au-dessus du socle
  const baseRing=new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.18, 10), matFonte);
  baseRing.position.y=0.39; g.add(baseRing);
  // fût cylindrique principal
  const shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 3.30, 10), matFonte);
  shaft.position.y=2.13; g.add(shaft);
  // 3 moulures sur le fût
  for(const y of [0.88, 1.78, 2.68]){
    const moul=new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.10, 10), matFonte);
    moul.position.y=y; g.add(moul);
  }
  // chapiteau (mouluration sous la potence)
  const cap=new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.14, 10), matFonte);
  cap.position.y=3.85; g.add(cap);
  // potence courbe (2 segments → simulant une courbe)
  g.add(_M7_fastBox(0.18, 0.08, 0.08, matFonte, 0.15, 3.96, 0, false));   // segment court
  g.add(_M7_fastBox(0.62, 0.08, 0.08, matFonte, 0.50, 3.96, 0, false));   // segment principal
  g.add(box(0.34,0.4,0.34,0x2a241c,0.68,3.7,0,false));                     // cage de la lanterne
  // FLAMME : petit mesh émissif dans la cage. emissiveIntensity piloté par updateWindowGlow.
  const flame=new THREE.Mesh(new THREE.SphereGeometry(0.22,8,8),
    new THREE.MeshStandardMaterial({color:0xffe6ad,emissive:0xffb347,emissiveIntensity:.6,flatShading:true}));
  flame.position.set(0.68,3.7,0); g.add(flame); g.userData.lamp=flame;
  // halo sprite (additif via blending, ici opacité simple)
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:_gasHaloTex,transparent:true,
    opacity:0,depthWrite:false}));
  halo.scale.set(3.6,3.6,1); halo.position.set(0.68,3.7,0); g.add(halo);
  // mare au sol
  const pool=new THREE.Mesh(new THREE.PlaneGeometry(7,7),
    new THREE.MeshBasicMaterial({map:_gasPoolTex,transparent:true,opacity:0,depthWrite:false}));
  pool.rotation.x=-Math.PI/2; pool.position.set(0.68,0.035,0); g.add(pool);
  // M4 — FAUX CÔNE de lumière sous la lanterne : ConeGeometry ouverte,
  // MeshBasicMaterial additif, dégradé d'opacité (0.16 en haut → 0 en bas) via
  // une atténuation par vertex colors. On garde une géométrie simple.
  const coneH=3.55, coneR=2.0;
  const cgeo=new THREE.ConeGeometry(coneR, coneH, 12, 1, true);     // ouvert
  // vertex colors : pleine opacité au sommet (apex), 0 à la base
  const pos=cgeo.attributes.position;
  const colors=new Float32Array(pos.count*3);
  for(let i=0;i<pos.count;i++){
    const y=pos.getY(i);
    // y va de +coneH/2 (apex) à -coneH/2 (base ouverte)
    const t=(y + coneH/2)/coneH;                 // 0 base → 1 apex
    colors[i*3]=colors[i*3+1]=colors[i*3+2]=t*t; // grad quadratique
  }
  cgeo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  const cmat=new THREE.MeshBasicMaterial({
    color:0xffb45e, transparent:true, opacity:0.16,
    depthWrite:false, blending:THREE.AdditiveBlending,
    side:THREE.DoubleSide, vertexColors:true,
    fog:false,
  });
  const cone=new THREE.Mesh(cgeo, cmat);
  // apex en haut (sous la flamme), base en bas (au sol). Cône natif a apex en +Y.
  cone.position.set(0.68, 3.7 - coneH/2, 0);
  cone.renderOrder=-1;
  g.add(cone);
  // entrée gasLamps : halo, pool, flame, cône, phase de flicker (sin bruité ±8%)
  gasLamps.push({
    halo, pool, flame, cone,
    ph: Math.random()*6.28,
    flickerSeed: Math.random()*100,
    group: g,
    // worldPos sera renseigné après attachement à la scène (M4.afterWorld)
    worldPos: null,
  });
  return g; }
function createFenceSegment(len=4){ const g=new THREE.Group();
  g.add(box(0.15,1.1,0.15,COL.brun,-len/2,0.55,0,false)); g.add(box(0.15,1.1,0.15,COL.brun,len/2,0.55,0,false));
  g.add(box(len,0.12,0.12,COL.brun,0,0.9,0,false)); g.add(box(len,0.12,0.12,COL.brun,0,0.45,0,false)); return g; }
function createSmallCart(){
  const g=new THREE.Group();
  const matBois=new THREE.MeshStandardMaterial({color:0x6b513a, map:texWood(), roughness:0.95, metalness:0, flatShading:true});
  const matBoisFonce=new THREE.MeshStandardMaterial({color:0x4a3625, roughness:0.95, metalness:0, flatShading:true});
  const matFer=new THREE.MeshStandardMaterial({color:0x2a241c, roughness:0.5, metalness:0.6, flatShading:true});
  const matHub=new THREE.MeshStandardMaterial({color:0x8a8076, roughness:0.5, metalness:0.6, flatShading:true});
  // plateau
  const plateau=new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 2.0), matBois);
  plateau.position.y=0.72; plateau.castShadow=true; g.add(plateau);
  // ridelles (3 côtés)
  g.add(_M7_fastBox(1.4, 0.40, 0.10, matBoisFonce, 0, 0.97, -0.95));
  g.add(_M7_fastBox(0.10, 0.40, 2.0, matBoisFonce, -0.65, 0.97, 0));
  g.add(_M7_fastBox(0.10, 0.40, 2.0, matBoisFonce, 0.65, 0.97, 0));
  // ROUES À RAYONS (4 roues : jante torique + moyeu cylindrique + 6 rayons)
  for(const sx of [-1, 1]) for(const sz of [-1, 1]){
    const wx=sx*0.82, wz=sz*0.70;
    // jante
    const rim=new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.06, 4, 14), matFer);
    rim.rotation.y=Math.PI/2;
    rim.position.set(wx, 0.40, wz);
    g.add(rim);
    // moyeu
    const hub=new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.14, 8), matHub);
    hub.rotation.z=Math.PI/2;
    hub.position.set(wx, 0.40, wz);
    g.add(hub);
    // 6 rayons (boxes plates tournés autour de l'axe)
    for(let i=0; i<6; i++){
      const spoke=new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.78, 0.03), matFer);
      spoke.position.set(wx, 0.40, wz);
      spoke.rotation.z=Math.PI/2;
      spoke.rotation.x=i*Math.PI/6;
      g.add(spoke);
    }
  }
  // brancards (poignées avant)
  for(const sx of [-1, 1]){
    const branc=_M7_fastBox(0.10, 0.08, 1.4, matBois, sx*0.42, 0.85, 1.55);
    g.add(branc);
  }
  // poignée transversale
  g.add(_M7_fastBox(1.0, 0.08, 0.08, matBois, 0, 0.85, 2.20));
  return g;
}
function createWagon(){ const g=new THREE.Group();
  g.add(box(2.6,1.5,4.2,0x4a4236,0,1,0,false)); g.add(box(2.8,0.4,4.4,COL.fer,0,1.85,0,false));
  for(const x of[-1.1,1.1])for(const z of[-1.4,1.4]){ const w=cyl(0.55,0.55,0.3,0x201c16,14); w.rotation.z=Math.PI/2; w.position.set(x,0.55,z); g.add(w); } return g; }
function createFactoryPipe(len=5){ const g=new THREE.Group();
  const m=cyl(0.4,0.4,len,COL.fer,10); m.material.map=texMetal(); m.rotation.z=Math.PI/2; m.position.y=2.4; g.add(m);
  for(const s of[-1,1]) g.add(box(0.55,0.55,0.55,0x3a352c,s*len/2,2.4,0,false)); return g; }
function createGear(r=1,c=COL.fer){ const g=new THREE.Group();
  const disc=cyl(r,r,0.3,c,16); disc.material.map=texMetal(); disc.rotation.x=Math.PI/2; g.add(disc);
  const T=10; for(let i=0;i<T;i++){ const a=i/T*6.283; g.add(box(0.26,0.3,0.26,c,Math.cos(a)*r,Math.sin(a)*r,0,false)); }
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.18,8,8),new THREE.MeshStandardMaterial({color:0x2c2620,flatShading:true})));
  g.userData.gear=true; return g; }
function createPulley(){ return createGear(0.8,0x3a352c); }
function createWorkbench(){ const g=new THREE.Group();
  g.add(box(2.2,0.25,1.1,0x6b513a,0,1,0,false));
  for(const x of[-0.9,0.9])for(const z of[-0.4,0.4]) g.add(box(0.18,1,0.18,0x4a3a28,x,0.5,z,false));
  g.add(box(0.3,0.3,0.3,COL.fer,0.6,1.25,0,false)); return g; }
function createWorkerHouse(h=3.2,c=COL.froid){ const g=new THREE.Group();
  // v64 : soubassement, débord de toit, vraie fenêtre éclairable, porte, mitron
  g.add(box(3.5,0.4,3.5,0x7e7565,0,0.2,0,false));
  const body=box(3.2,h,3.2,c,0,h/2+0.25,0); body.material.map=texBrick(); g.add(body); addOutline(body);
  const roof=new THREE.Mesh(new THREE.ConeGeometry(2.95,1.7,4),new THREE.MeshStandardMaterial({color:0x46393b,flatShading:true}));
  roof.position.y=h+1.05; roof.rotation.y=Math.PI/4; g.add(roof);
  const chim=box(0.5,1.3,0.5,COL.charbon,1,h+0.7,1,false); g.add(chim);
  g.add(box(0.7,0.16,0.7,0x6e6354,1,h+1.36,1,false));                     // chapeau
  const w=createWindow(0.62,0.7); w.position.set(-0.78,h*0.58,1.66); g.add(w);   // s'allume la nuit
  g.add(box(0.7,1.5,0.08,0x2a241d,0.78,1.0,1.64,false));                  // porte
  g.add(box(0.9,0.18,0.7,0x9a9183,0.78,0.09,1.85,false));                 // seuil
  return g; }
function createChimney(h=8){ const g=new THREE.Group();
  const m=box(1.6,h,1.6,COL.charbon,0,h/2,0); m.material.map=texBrick(); g.add(m);
  g.add(box(2,0.5,2,0x2a241d,0,h,0,false)); return g; }
function createMarketStall(c=COL.rouge){ const g=new THREE.Group();
  for(const x of[-1.3,1.3])for(const z of[-0.9,0.9]) g.add(box(0.15,2,0.15,COL.brun,x,1,z,false));
  const awn=box(3,0.2,2.2,c,0,2.1,0,false); awn.rotation.x=0.12; g.add(awn);
  g.add(box(2.8,0.25,1.8,0x6b513a,0,1.3,0,false)); return g; }
function createRopeLine(len=4){ const g=new THREE.Group();
  g.add(box(0.06,0.06,len,0x2a241d,0,2.4,0,false)); const cols=[0x8a3b2a,0x4d5f70,0xcdbd9a,0x6b513a];
  // M-Polish/B : chaque pièce de linge est taguée pour le battement procédural.
  for(let i=0;i<4;i++){ const cloth=box(0.5,0.7,0.04,cols[i%4],0,2.0,-len/2+0.6+i*((len-1.2)/3),false);
    cloth.userData.linge=true; g.add(cloth); }
  return g; }
function createPosterBoard(text){ const g=new THREE.Group();
  g.add(box(0.18,2.6,0.18,COL.brun,0,1.3,0,false));
  const lab=makeLabel(text); lab.scale.set(5,1.25,1); lab.position.set(0,3,0); g.add(lab); return g; }
function createLedgerPlaque(text){ return makeLabel(text); }
/* ===== v54 — habillage du monde, manière diorama-jouet (cf. bruno-simon.com)
   sobre et papier : arbres en boules superposées, buissons, rochers à facettes,
   meules de foin — et de grandes TYPOGRAPHIES À L'ENCRE posées au sol, comme
   sur une carte ancienne. Tout reste dans la palette existante. ===== */
/* M7 — createTree / createBush remontés aux gabarits irréguliers.
   Géométries cachées (1 par kind) puis partagées entre les Group individuels.
   Pas de ConeGeometry. */
const _M7_geoCache={};
function _M7_cachedTrunk(kind){
  if(!_M7_geoCache['trunk_'+kind]) _M7_geoCache['trunk_'+kind]=_M7_trunkGeo(kind);
  return _M7_geoCache['trunk_'+kind];
}
function _M7_cachedFoliage(kind){
  if(!_M7_geoCache['fol_'+kind]) _M7_geoCache['fol_'+kind]=_M7_foliageGeo(kind);
  return _M7_geoCache['fol_'+kind];
}
function createTree(h=5, c=0x6b7a4a){
  // sélection pseudo-aléatoire du gabarit (avec un peu de bruit déterministe)
  const kinds=['chene','chene','trogne','peuplier'];
  const kind=kinds[Math.floor(Math.random()*kinds.length)];
  const g=new THREE.Group();
  const tg=_M7_cachedTrunk(kind);
  const fg=_M7_cachedFoliage(kind);
  const tronc=new THREE.Mesh(tg,
    new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true}));
  g.add(tronc);
  const fol=new THREE.Mesh(fg,
    new THREE.MeshStandardMaterial({color:c, roughness:1.0, metalness:0, flatShading:true}));
  fol.position.y=_M7_TREE_PARAMS[kind].foliageY + 0.4;
  g.add(fol);
  // scale pour correspondre à `h` demandé
  const baseH=_M7_TREE_PARAMS[kind].trunk[2] + _M7_TREE_PARAMS[kind].foliageY*0.7;
  const s=h / baseH;
  g.scale.set(s, s, s);
  g.rotation.y=Math.random() * Math.PI * 2;
  return g;
}
function createBush(r=1.1){
  if(!_M7_geoCache['bush']) _M7_geoCache['bush']=_M7_bushGeo(0);
  const m=new THREE.Mesh(_M7_geoCache['bush'],
    new THREE.MeshStandardMaterial({color:0x556b3a, roughness:1.0, metalness:0, flatShading:true}));
  m.rotation.y=Math.random() * Math.PI * 2;
  const s=r / 0.55;
  m.scale.set(s*(0.9+Math.random()*0.2), s*(0.8+Math.random()*0.2), s*(0.9+Math.random()*0.2));
  return m;
}
function createRock(r=1.0){ const m=new THREE.Mesh(new THREE.IcosahedronGeometry(r,0),
    new THREE.MeshStandardMaterial({color:0x8a8275,roughness:1,flatShading:true}));
  m.position.y=r*0.6; m.scale.y=0.7; m.rotation.y=Math.random()*3; return m; }
function createHaystack(){ const m=new THREE.Mesh(new THREE.ConeGeometry(1.5,2.3,9),
    new THREE.MeshStandardMaterial({color:0xb9a26b,roughness:1,flatShading:true}));
  m.position.y=1.15; return m; }
function createGroundText(text,w=30){
  const c=document.createElement('canvas'); c.width=1024; c.height=192; const x=c.getContext('2d');
  x.clearRect(0,0,1024,192); x.fillStyle='rgba(36,31,23,0.5)';
  x.font='700 96px "IBM Plex Mono",monospace'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText(text.toUpperCase(),512,100);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=4;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,w*192/1024),
    new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
  m.rotation.x=-Math.PI/2; m.position.y=0.025; return m; }
/* ===== v56 — éléments de cohérence et de beauté ===== */
function createWindmill(h=9){ const g=new THREE.Group();
  const tour=cyl(1.1,1.8,h,0x9c8f74,9); tour.position.y=h/2; g.add(tour); addOutline(tour);
  const cap=new THREE.Mesh(new THREE.ConeGeometry(1.5,1.6,9),
    new THREE.MeshStandardMaterial({color:0x46393b,flatShading:true,roughness:1}));
  cap.position.y=h+0.7; g.add(cap);
  const ailes=new THREE.Group();                       // userData.gear -> tournent via l'anim existante
  for(let i=0;i<4;i++){ const a=box(0.5,h*0.62,0.1,0xcdbd9a,0,h*0.31,0,false);
    const arm=new THREE.Group(); arm.add(a); arm.rotation.z=i*Math.PI/2; ailes.add(arm); }
  ailes.position.set(0,h*0.86,1.7); ailes.userData.gear=true; g.add(ailes);
  const porte=createDoor(); porte.position.set(0,0,1.7); g.add(porte);
  return g; }
function createScarecrow(){ const g=new THREE.Group();
  g.add(box(0.16,2.2,0.16,0x6b513a,0,1.1,0,false)); g.add(box(1.6,0.14,0.14,0x6b513a,0,1.7,0,false));
  g.add(box(0.7,0.8,0.3,0x8a3b2a,0,1.45,0,false));
  const tete=new THREE.Mesh(new THREE.SphereGeometry(0.3,7,6),new THREE.MeshStandardMaterial({color:0xcdbd9a,flatShading:true}));
  tete.position.y=2.15; g.add(tete);
  const chap=new THREE.Mesh(new THREE.ConeGeometry(0.42,0.35,8),new THREE.MeshStandardMaterial({color:0x46393b,flatShading:true}));
  chap.position.y=2.42; g.add(chap); return g; }
function createWell(){ const g=new THREE.Group();
  const mur=cyl(1.0,1.1,0.9,0x8a8275,10); mur.position.y=0.45; g.add(mur); addOutline(mur);
  for(const x of[-0.9,0.9]) g.add(box(0.14,1.6,0.14,0x6b513a,x,1.2,0,false));
  const toit=new THREE.Mesh(new THREE.ConeGeometry(1.4,0.8,4),new THREE.MeshStandardMaterial({color:0x46393b,flatShading:true}));
  toit.position.y=2.2; toit.rotation.y=Math.PI/4; g.add(toit);
  g.add(box(1.8,0.1,0.1,0x4a4236,0,1.85,0,false)); return g; }
function createBoat(){ const g=new THREE.Group();
  const coque=box(2.2,0.8,5.2,0x6b513a,0,0.5,0,false); g.add(coque); addOutline(coque);
  g.add(box(1.8,0.3,4.4,0x8b7d63,0,0.95,0,false));
  g.add(box(0.14,4.2,0.14,0x4a4236,0,3,0.4,false));
  const voile=new THREE.Mesh(new THREE.PlaneGeometry(1.9,2.6),
    new THREE.MeshStandardMaterial({color:0xe4d7ba,side:THREE.DoubleSide,flatShading:true}));
  voile.position.set(0.05,3.4,0.4); voile.rotation.y=0.25; g.add(voile);
  return g; }
function createCloud(){ const g=new THREE.Group();
  for(let i=0;i<3;i++){ const r=2.2+Math.random()*1.6;
    const b=new THREE.Mesh(new THREE.SphereGeometry(r,7,6),
      new THREE.MeshStandardMaterial({color:0xeae2d0,flatShading:true,roughness:1,transparent:true,opacity:.92}));
    b.position.set(i*2.6-2.6,Math.random()*0.8,(Math.random()-0.5)*1.6); b.scale.y=0.55; g.add(b); }
  return g; }
function createBird(){ const g=new THREE.Group();
  const w1=box(1.1,0.06,0.3,0x241f17,-0.55,0,0,false), w2=box(1.1,0.06,0.3,0x241f17,0.55,0,0,false);
  g.add(w1); g.add(w2); g.userData.w1=w1; g.userData.w2=w2; return g; }
function createGroundDecal(draw,w){            // décor de carte (rose des vents, cartouche)
  const c=document.createElement('canvas'); c.width=1024; c.height=1024; const x=c.getContext('2d');
  draw(x,1024); const tex=new THREE.CanvasTexture(c); tex.anisotropy=4;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,w),
    new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,opacity:.8}));
  m.rotation.x=-Math.PI/2; m.position.y=0.022; return m; }
function createCompassRose(w=22){ return createGroundDecal((x,S)=>{
  const C=S/2; x.strokeStyle=x.fillStyle='rgba(36,31,23,0.75)'; x.lineWidth=6;
  x.beginPath(); x.arc(C,C,S*0.30,0,6.3); x.stroke();
  x.beginPath(); x.arc(C,C,S*0.36,0,6.3); x.stroke();
  for(let i=0;i<8;i++){ const a=i*Math.PI/4, L=i%2?S*0.22:S*0.42;
    x.save(); x.translate(C,C); x.rotate(a);
    x.beginPath(); x.moveTo(0,-L); x.lineTo(S*0.035,0); x.lineTo(-S*0.035,0); x.closePath();
    i%2?x.stroke():x.fill(); x.restore(); }
  x.font='700 90px "IBM Plex Mono",monospace'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText('N',C,C-S*0.45); x.fillText('S',C,C+S*0.46); x.fillText('E',C+S*0.46,C); x.fillText('O',C-S*0.46,C);
 },w); }
function createMapCartouche(w=36){ return createGroundDecal((x,S)=>{
  x.strokeStyle=x.fillStyle='rgba(36,31,23,0.8)';
  x.lineWidth=10; x.strokeRect(S*0.06,S*0.30,S*0.88,S*0.40);
  x.lineWidth=3;  x.strokeRect(S*0.085,S*0.325,S*0.83,S*0.35);
  x.font='700 84px "IBM Plex Mono",monospace'; x.textAlign='center';
  x.fillText('LE CIRCUIT DU CAPITAL',S/2,S*0.46);
  x.font='400 46px "IBM Plex Mono",monospace';
  x.fillText('Carte de la formation sociale',S/2,S*0.56);
  x.fillText('· Anno MDCCCXLVIII ·',S/2,S*0.63);
 },w); }
function createConeMarker(){ const g=new THREE.Group();
  g.add(new THREE.Mesh(new THREE.ConeGeometry(0.45,1.1,10),new THREE.MeshStandardMaterial({color:COL.rouge,flatShading:true})).translateY?
    (()=>{const m=new THREE.Mesh(new THREE.ConeGeometry(0.45,1.1,10),new THREE.MeshStandardMaterial({color:COL.rouge,flatShading:true}));m.position.y=0.55;return m;})():null);
  g.add(box(0.8,0.12,0.8,0x2a241d,0,0.06,0,false)); return g; }

/* --- peuplement --- */
let envGroup=null, envProps=[], kickProps=[], envLamps=[], envGears=[], envReady=false;
let sunLight=null, hemiLight=null;   // v57 : poignées du cycle de lumière
let nightAmbient=null;               // M7 : floor warm nocturne (sol lisible la nuit)
let moonLight=null;                  // M7-soleil : directionnelle de la lune (bleu froid)
let composer=null, bloomPass=null, gradePass=null;   // v66/M1 : bloom + GradePass (null si bypass)
let bokehPass=null;                                  // M-Cinéma : DoF (BokehPass) entre bloom et grade

/* M1 — GradeShader : ShaderPass terminal, trois effets dans un seul shader.
   (a) split-tone : ombres tirées vers uShadowTint, hautes lumières vers
       uHighlightTint, pivot par luminance Y autour de 0.5, force uSplitStrength.
   (b) vignette radiale douce : assombrissement progressif à partir d'un rayon
       interne, plafonné à uVignetteMax aux coins.
   (c) grain de film animé : bruit hash 2D modulé par uTime, amplitude uGrain. */
const GradeShader = {
  uniforms:{
    tDiffuse:        { value:null },
    uTime:           { value:0 },
    // M8 — la teinte d'ombre est éclaircie (0x2a3550 → 0x3f4d6b) et la force
    // du split abaissée : le bleu-encre reste, mais il ne mange plus les bas
    // niveaux. La vignette est également adoucie (0.22 → 0.15).
    uShadowTint:     { value:new THREE_BASE.Color(0x3f4d6b) },
    uHighlightTint:  { value:new THREE_BASE.Color(0xffc98a) },
    uSplitPivot:     { value:0.5 },
    uSplitStrength:  { value:0.28 },
    uVignetteMax:    { value:0.15 },
    uGrain:          { value:0.025 },
    // M8 — ROLL-OFF DES HAUTES LUMIÈRES. Au-delà de uHiKnee : (1) la chroma
    // est ramenée vers le gris, donc une surface qui sature blanchit comme
    // sur une pellicule au lieu de virer à l'aplat de couleur pure (ors,
    // braises, lanternes, tôles au soleil) ; (2) uHiGain rabaisse en plus
    // leur intensité. Mesuré sur le plein jour : saturation moyenne des
    // pixels chauds 0.56 → 0.05, sans bouger la luminance moyenne du cadre.
    uHiKnee:         { value:0.50 },
    uHiDesat:        { value:0.85 },
    uHiGain:         { value:0.88 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3  uShadowTint;
    uniform vec3  uHighlightTint;
    uniform float uSplitPivot;
    uniform float uSplitStrength;
    uniform float uVignetteMax;
    uniform float uGrain;
    uniform float uHiKnee;
    uniform float uHiDesat;
    uniform float uHiGain;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    float luma(vec3 c){ return dot(c, LUMA); }
    // teinte ramenée à luminance 1 : elle DÉPLACE la couleur sans ajouter
    // de gain (cf. split-tone ci-dessous).
    vec3 unitTint(vec3 c){ return c / max(1e-4, luma(c)); }

    float hash21(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main(){
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb;

      // (a) split-tone par luminance — M8 : les teintes sont NORMALISÉES
      // (unitTint) au lieu d'être multipliées par 2.0. L'ancienne formule
      // appliquait aux hautes lumières un gain (2.00, 1.58, 1.08) : tout ce
      // qui était clair montait ET virait à l'orange, puis clippait en aplat
      // saturé. Le split ne fait plus que déplacer la couleur.
      float Y = luma(col);
      float shadowMask    = smoothstep(uSplitPivot, 0.0, Y);
      float highlightMask = smoothstep(uSplitPivot, 1.0, Y);
      col = mix(col, col * unitTint(uShadowTint),    shadowMask    * uSplitStrength);
      col = mix(col, col * unitTint(uHighlightTint), highlightMask * uSplitStrength);

      // (a bis) ROLL-OFF DES HAUTES LUMIÈRES — M8. Passé uHiKnee, la chroma
      // se retire progressivement : une surface qui sature blanchit au lieu
      // de devenir une tache de couleur pure. uHiGain rabaisse ensuite son
      // intensité — c'est ce qui empêche les émissifs (or, forge, lanternes)
      // de se lire comme des aplats en surbrillance.
      float Yh  = luma(col);
      float hot = smoothstep(uHiKnee, 1.0, Yh);
      col = mix(col, vec3(Yh), hot * uHiDesat);
      col *= mix(1.0, uHiGain, hot);

      // (b) vignette radiale
      vec2 d = vUv - 0.5;
      float r = length(d) * 1.41421356;        // 0 au centre, ~1 aux coins
      float vig = smoothstep(0.55, 1.0, r) * uVignetteMax;
      col *= (1.0 - vig);

      // (c) grain animé
      if(uGrain > 0.0){
        float n = hash21(vUv * vec2(1920.0, 1080.0) + uTime * 60.0) - 0.5;
        col += n * uGrain;
      }

      gl_FragColor = vec4(col, src.a);
    }
  `,
};

/* M1 — qualité de rendu (Basse/Moyenne/Haute), distincte de GRAPHICS_QUALITY
   (densité des effets de scène) et DETAIL_LEVEL (peuplement). Pilote la
   chaîne post-prod : composer bypass, grain, taille shadowMap, ombres. */
let RENDER_QUALITY = 'high';    // 'low' | 'medium' | 'high'
let COMPOSER_BYPASS = false;    // forcé en 'low'

function applyRenderQuality(q){
  if(q !== 'low' && q !== 'medium' && q !== 'high') return;
  RENDER_QUALITY = q;
  // Haute  : composer + grain + shadowMap 2048.
  // Moyenne: composer (post-prod active) + PAS de grain + shadowMap 1024.
  // Basse  : composer COMPLÈTEMENT bypassé (pas de bloom, pas de grade) + ombres OFF.
  COMPOSER_BYPASS = (q === 'low');
  const grain = (q === 'high') ? 0.025 : 0.0;
  if(gradePass){ gradePass.uniforms.uGrain.value = grain; }
  // M-Cinéma-b/C : DoF OFF PAR DÉFAUT en jeu. On ne le ré-active jamais
  //   ici — c'est CinemaMode.begin/end qui pilote bokehPass.enabled le
  //   temps d'une séquence. Si la qualité passe à 'low' PENDANT le cinéma,
  //   on force enabled=false (économie de la render-pass de profondeur).
  if(bokehPass && q === 'low'){ bokehPass.enabled = false; }
  let shadowsOn = false, shadowSize = 0;
  if(typeof renderer !== 'undefined' && renderer){
    if(q === 'low'){
      renderer.shadowMap.enabled = false;
    } else {
      renderer.shadowMap.enabled = true;
      shadowSize = (q === 'medium') ? 1024 : 2048;
      if(sunLight && sunLight.shadow && sunLight.shadow.mapSize.x !== shadowSize){
        sunLight.shadow.mapSize.set(shadowSize, shadowSize);
        // dispose force la recréation de la shadow map à la prochaine frame.
        if(sunLight.shadow.map){ sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
      }
    }
    shadowsOn = renderer.shadowMap.enabled;
  }
  const composerState = (composer && !COMPOSER_BYPASS) ? 'on' : (composer ? 'bypass' : 'absent');
  // M3 — flaques (réfléchissantes ↔ mates) et débris (densité écrêtée)
  // suivent le sélecteur de qualité.
  if(typeof _applyM3Quality === 'function') _applyM3Quality(q);
  // M2 — fumées de skyline, godrays, voile doré, nuages : OFF en Basse.
  // Dôme + skyline + soleil conservés (forme du ciel inchangée).
  if(typeof _applyM2Quality === 'function') _applyM2Quality(q);
  // M4 — cônes, reflets, flicker : OFF en Basse. PointLights réduites à 4.
  if(typeof _applyM4Quality === 'function') _applyM4Quality(q);
  // M6-bord — collines simplifiées, voiliers distants masqués en Basse.
  if(typeof _applyM6BordQuality === 'function') _applyM6BordQuality(q);
  // M1b — log lisible pour valider que les 3 niveaux produisent des configs
  // distinctes. Une seule ligne par changement, à la console.
  console.info('[M1] render quality =', q,
    '· composer:', composerState,
    '· shadowMap:', shadowsOn ? (shadowSize+'×'+shadowSize) : 'off',
    '· grain:', grain>0 ? 'on('+grain+')' : 'off');
}
if(typeof window !== 'undefined') window.applyRenderQuality = applyRenderQuality;
function envPut(obj,x,z,rot=0,stage=0,kick=false){
  obj.position.set(x,0,z); if(rot) obj.rotation.y=rot; obj.userData.stage=stage;
  envGroup.add(obj); envProps.push({obj,stage});
  obj.traverse&&obj.traverse(o=>{ if(o.userData&&o.userData.lamp) envLamps.push(o.userData.lamp); if(o.userData&&o.userData.gear) envGears.push(o); });
  if(kick) kickProps.push({obj,vx:0,vz:0,vr:0});
  return obj;
}
function placeAround(zname,items){ const p=zonePos(zname); const n=Math.ceil(items.length*dDen());
  items.slice(0,n).forEach(it=>{ const o=it[0](); envPut(o,p.x+it[1],p.z+it[2],it[3]||0,it[4]||0,it[5]||false); }); }

function populateBankDistrict(){ placeAround('Banque',[
  [()=>createLedgerPlaque('£'),0,9,0,0], [()=>createCrateStack(),-9,-3,0.3,0],
  [()=>createLampPost(),9,7,0,0], [()=>createLampPost(),-9,7,0,0],
  [()=>createFenceSegment(6),0,10,0,0], [()=>createBarrel(),8,-4,0,0,true],
  [()=>createSack(),9,-6,0,1], [()=>createSack(0xbfa97e),9.8,-5,0,1],
  [()=>createPosterBoard('REGISTRE'),-9,8,0.4,1], [()=>createConeMarker(),5,9,0,0,true],
]); }
function populateMeansMarket(){ placeAround('Marché des moyens',[
  [()=>createCoalPile(),-9,4,0,1], [()=>createCrateStack(),8,3,0.2,0],
  [()=>createSack(),9,-2,0,0], [()=>createSack(0xc4b184),9.7,-3,0,0], [()=>createSack(0xb7a072),8.6,-3.6,0,0],
  [()=>createBarrel(),-8,-4,0,0,true], [()=>createBarrel(0x5e4326),-9,-5.4,0,0,true],
  [()=>createPulley(),7,9,0,1], [()=>createSmallCart(),0,10,0.5,1,true],
  [()=>createPosterBoard('M — MOYENS'),-2,11,0,0], [()=>createLampPost(),10,8,0,0],
]); }
function populateLaborSquare(){ placeAround('Marché du travail',[
  // M-Peuple : les figures du marché du travail sont gérées par PeuplePop
  // (file de chômeurs ∝ chômage réel). Plus aucun spawn décoratif ici, qui
  // laissait des silhouettes pâles sans rôle ni rafraîchissement.
  [()=>createPosterBoard('Ft — FORCE DE TRAVAIL'),0,10,0,0],
  [()=>box(2.4,0.4,0.7,0x5a4530,0,0.4,0,false),5,8,0,0],   // banc
  [()=>createWorkerHouse(2.8),11,6,0,2], [()=>createWorkerHouse(3.0),12,9,0,2],
  [()=>createLampPost(),-8,7,0,0], [()=>createFenceSegment(6),-7,10,0,0],
]); }
function populateFactoryYard(){ placeAround('Usine',[
  [()=>createChimney(11),10,-3,0,1], [()=>createFactoryPipe(6),-8,4,0,1],
  [()=>createGear(1.2),9,5,0,2], [()=>createGear(0.9),9,7.4,0,2],
  [()=>createWorkbench(),-7,7,0.3,1], [()=>createCrateStack(),7,8,0,0],
  [()=>createCoalPile(),11,8,0,1], [()=>createPosterBoard('⚠ DANGER'),-9,9,0.2,1],
  [()=>box(10,0.4,8,0x9a8a66,0,0.2,9,false),0,9,0,0],     // cour / plateforme basse
  [()=>createLampPost(),-9,-2,0,0], [()=>createSmallCart(),-3,10,0.4,0,true],
]); }
function populateWarehouseDock(){ placeAround('Entrepôt',[
  [()=>box(12,0.5,6,0x8d7c58,0,0.25,8,false),0,8,0,0],    // quai de chargement (relief)
  [()=>createCrateStack(),-6,8,0,0], [()=>createCrateStack(),-3.5,8.2,0.2,0],
  [()=>createCrateStack(),6,8,0,1], [()=>createWagon(),0,12,0,2],
  [()=>createBrokenCrate(),9,5,0.6,2], [()=>createBarrel(),-9,4,0,0,true],
  [()=>createSmallCart(),3,10,0.3,1,true], [()=>createLampPost(),9,9,0,0],
  [()=>createPosterBoard('ENTREPÔT'),-9,9,0,0],
]); }
function populateSaleMarket(){ placeAround('Marché de vente',[
  [()=>createMarketStall(),-7,7,0,0], [()=>createMarketStall(COL.bleu),0,8,0,0], [()=>createMarketStall(COL.vert),7,7,0,1],
  [()=>createPriceBoard('£'),-4,10,0,0], [()=>createPriceBoard('£'),4,10,0.3,0],
  [()=>createPosterBoard('PRIX BAS'),9,8,0.3,1], [()=>createCrateStack(),-9,4,0,0],
  [()=>createBarrel(),9,4,0,0,true], [()=>createLampPost(),-9,9,0,0], [()=>createConeMarker(),2,11,0,0,true],
]); }
function populateWorkerDistrict(){ placeAround('Quartier ouvrier',[
  [()=>createWorkerHouse(3.0),-7,8,0,0], [()=>createWorkerHouse(3.4),-3.5,8.4,0,0], [()=>createWorkerHouse(2.8),0,9,0,0],
  [()=>createWorkerHouse(3.2),4,8.4,0,2], [()=>createWorkerHouse(3.0),7.5,8,0,2],
  [()=>createRopeLine(5),-5,5,0.2,1], [()=>createRopeLine(4),1,5.4,0,1],
  [()=>createLampPost(),-9,6,0,0], [()=>createLampPost(),9,6,0,0],
  [()=>box(2.4,0.4,0.7,0x5a4530,-6,0.4,3.5,false),-6,3.5,0,0], [()=>createFenceSegment(6),3,10,0,0],
]); }
/* v54 — le monde se remplit par régions de caractère, à densité contrôlée.
   La plupart des petits objets sont BOUSCULABLES (kick=true) : le chariot du
   joueur peut les pousser — l'espace devient un terrain de jeu, sans rien
   changer aux règles. */
function populateWorldDressing(){
  const J=(a,b)=>a+Math.random()*(b-a);
  const free=(x,z)=>!zones.some(zz=>((zz.pos.x-x)**2+(zz.pos.z-z)**2)<14*14) && Math.abs(z)>9.5;
  const sprinkle=(n,xa,xb,za,zb,mk,kick)=>{ n=Math.ceil(n*dDen());
    for(let i=0;i<n;i++){ const x=J(xa,xb), z=J(za,zb);
      if(!free(x,z)) continue; envPut(mk(),x,z,Math.random()*6.28,0,kick); } };
  /* ---- v55 : éléments à GRANDE EMPREINTE — c'est eux qui mangent le vide ---- */
  // tache d'herbe sombre (quasi gratuit, casse la monotonie du papier)
  const grass=(x,z,r)=>{ if(!free(x,z)) return; const m=new THREE.Mesh(new THREE.CircleGeometry(r,14),
      new THREE.MeshStandardMaterial({color:0xa3a06e,roughness:1,transparent:true,opacity:.5}));
    m.rotation.x=-Math.PI/2; m.rotation.z=Math.random()*3; m.position.set(x,0.012,z); envGroup.add(m); };
  // champ cultivé : parcelle + sillons
  const field=(x,z,w,d,rot)=>{ if(!free(x,z)) return; const g=new THREE.Group();
    const base=new THREE.Mesh(new THREE.PlaneGeometry(w,d),
      new THREE.MeshStandardMaterial({color:0xb09a6a,roughness:1}));
    base.rotation.x=-Math.PI/2; base.position.y=0.014; g.add(base);
    for(let i=1;i<Math.floor(d/2.4);i++) g.add(box(w*0.92,0.1,0.35,0x8f7a4f,0,0.06,-d/2+i*2.4,false));
    g.rotation.y=rot||0; envPut(g,x,z,0,0); };
  // bosquet : un bois de n arbres dans un rayon r
  const wood=(x,z,r,n)=>{ n=Math.ceil(n*dDen());
    for(let i=0;i<n;i++){ const a=Math.random()*6.28, rr=Math.sqrt(Math.random())*r;
      const px=x+Math.cos(a)*rr, pz=z+Math.sin(a)*rr;
      if(!free(px,pz)) continue; envPut(createTree(J(3.5,6.5)),px,pz,Math.random()*6.28,0); } };
  // hameau : ferme + meule + clôture + arbre
  const hamlet=(x,z)=>{ if(!free(x,z)) return;
    envPut(createWorkerHouse(3.2,0x8b7d63),x,z,J(0,6.28),0);
    envPut(createHaystack(),x+4,z+2,0,0,true); envPut(createTree(4.5),x-4,z-3,0,0);
    const f=createFenceSegment(5); envPut(f,x+2,z-4,J(0,3),0); };
  // haie : rangée de clôtures entre deux points
  const hedge=(x0,z0,x1,z1)=>{ const L=Math.hypot(x1-x0,z1-z0), n=Math.floor(L/4.2*dDen());
    const rot=Math.atan2(x1-x0,z1-z0);
    for(let i=0;i<n;i++){ const k=(i+0.5)/n, px=x0+(x1-x0)*k, pz=z0+(z1-z0)*k;
      if(!free(px,pz)) continue; envPut(createFenceSegment(3.8),px,pz,rot,0); } };

  // — LES COINS : la campagne entoure la ville (le monde déborde la rue)
  wood(-100,-92,16,9); wood(-108,30,14,8); wood(-92,72,15,8);       // ouest & sud-ouest
  wood(72,-82,17,9);   wood(96,-50,12,6);                            // nord-est
  wood(62,78,16,8);    wood(96,58,12,6);                             // sud-est
  wood(-48,86,13,6);   wood(30,-90,14,7);                            // sud & nord
  // — champs autour de Mines·Champs et en bordure
  field(-86,-78,18,12,0.3); field(-62,-86,16,10,-0.2); field(-112,-44,14,16,0);
  field(44,-86,20,12,0.15); field(88,72,16,11,0.4);
  // — hameaux dispersés : le monde est habité avant le capital
  hamlet(-94,52); hamlet(-78,-52); hamlet(36,84); hamlet(80,-72);
  // — haies de bocage à l'ouest
  hedge(-116,-20,-86,-34); hedge(-110,46,-82,60);
  // — taches d'herbe un peu partout (15, quasi gratuites)
  for(let i=0;i<15;i++) grass(J(-110,110),(Math.random()<0.5?-1:1)*J(14,108),J(4,9));
  // — v56 : moulins à vent (ailes animées par l'anim des engrenages), épouvantails, puits
  envPut(createWindmill(10),-96,-44,0.4,0); envPut(createWindmill(8.5),-88,40,-0.3,0);
  envPut(createScarecrow(),-84,-76,0.5,0,true); envPut(createScarecrow(),-60,-84,-0.4,0,true);
  envPut(createScarecrow(),46,-84,0.2,0,true);
  envPut(createWell(),-92,54,0,0); envPut(createWell(),34,82,0.6,0);
  // — quartier ouvrier : cordes à linge entre les maisons, affiches
  const QO=zonePos('Quartier ouvrier');
  envPut(createRopeLine(5),QO.x-10,QO.z+10,0.4,0); envPut(createRopeLine(4),QO.x+11,QO.z+9,-0.6,0);
  envPut(createRopeLine(5),QO.x-4,QO.z+13,1.1,0);
  envPut(createPosterBoard('TRAVAIL · PAIN'),QO.x+12,QO.z-10,0.3,0); envPut(createPosterBoard('RÉUNION CE SOIR'),QO.x-13,QO.z-8,-0.4,0);
  // — mines : tas de charbon + wagonnet sur un bout de rail
  const MN=zonePos('Mines · Champs');
  envPut(createCoalPile(),MN.x+9,MN.z+8,0,0); envPut(createCoalPile(),MN.x+12,MN.z+11,0.7,0);
  envPut(createCoalPile(),MN.x+7,MN.z+12,1.4,0);
  const rl=createRailSegment(9); rl.rotation.y=0.5; envPut(rl,MN.x+11,MN.z+16,0,0);
  const wt=createSmallCart(); envPut(wt,MN.x+11,MN.z+16,0.5,0,true);
  // v66 — rose des vents et cartouche RETIRÉS (décors de carte dessinée).

  // — l'Ouest rural : sous-bois, meules, rochers
  sprinkle(12,-116,-70,-95,-35,  ()=>createBush(J(0.8,1.5)), true);
  sprinkle(6, -118,-86,-80,-40,  createHaystack, true);
  sprinkle(9, -116,-70,-92,-25,  ()=>createRock(J(0.6,1.4)));
  sprinkle(8, -116,-70, 14, 64,  ()=>createBush(J(0.8,1.3)), true);
  // — bords de la grand-rue : poteaux, tonneaux, cônes, charrettes garées (à pousser !)
  sprinkle(14,-100, 92, 9.5, 13.5, createBarrel, true);
  sprinkle(10,-100, 92, -13.5, -9.5, createConeMarker, true);
  sprinkle(6, -90, 84, 9.5, 13,  createSmallCart, true);
  for(let x=-96;x<=88;x+=23) envPut(createLampPost(),x,(x/23)%2?11.5:-11.5,0,0);
  // — ceinture industrielle sud : palettes, engrenages, tonneaux, sacs
  sprinkle(12,-75, 95, 40, 54,   createCrateStack);
  sprinkle(9, -70, 95, 38, 54,   createBarrel, true);
  sprinkle(5, -50, 70, 40, 52,   ()=>createGear(J(0.8,1.3)));
  sprinkle(7, -70, 95, 40, 52,   createSack, true);
  // — l'Est portuaire : quais encombrés
  sprinkle(9, 78, 114, -20, 24,  createCrateStack);
  sprinkle(8, 76, 112, -18, 22,  createSack, true);
  sprinkle(5, 80, 112, -16, 20,  createBarrel, true);
  // — le Nord institutionnel : alignements sobres, buissons taillés
  sprinkle(7, -85, 30, -48, -38, createLampPost);
  sprinkle(8, -62, 32, -50, -38, ()=>createBush(1.0), true);
  sprinkle(4, -88, 28, -50, -40, ()=>createPosterBoard(['AVIS','DÉCRET','ANNONCES','£'][Math.floor(Math.random()*4)]), false);
  // v66 — typographies au sol RETIRÉES (élément « carte dessinée », contraire
  // à la nouvelle identité). La géographie se lit par la lumière et les volumes.
}
function populateRoadsideDetails(){
  // dispersion légère le long du parcours principal (objets bousculables + repères)
  const path=['Banque','Marché des moyens','Marché du travail','Usine','Entrepôt','Marché de vente'];
  for(let i=0;i<path.length;i++){ const a=zonePos(path[i]), b=zonePos(path[(i+1)%path.length]);
    for(const f of[0.34,0.66]){ const x=a.x+(b.x-a.x)*f, z=a.z+(b.z-a.z)*f;
      const nx=-(b.z-a.z), nz=(b.x-a.x), nl=Math.hypot(nx,nz)||1; const ox=nx/nl*10, oz=nz/nl*10;
      envPut(createLampPost(), x+ox, z+oz, 0, 0);
      if(dDen()>0.5) envPut(createBarrel(), x-ox*0.85, z-oz*0.85, 0, 0, true);
      if(DETAIL_LEVEL==='high') envPut(createConeMarker(), x+ox*0.55, z+oz*0.55, 0, 0, true);
    }
  }
}
function populateIndustrialBackground(){
  // silhouettes lointaines : cheminées + tour d'horloge, hors couloir de jeu
  const far=[[ -30,-95,9],[ -42,-90,11],[ 95,40,10],[ 100,55,8],[ -95,-40,9]];
  far.forEach(p=>envPut(createChimney(p[2]),p[0],p[1],0,0));
  const tower=new THREE.Group();
  tower.add(box(4,16,4,COL.pierre,0,8,0)); tower.add(box(5,1,5,COL.charbon,0,16.5,0,false));
  const face=makeLabel('🕑'); face.scale.set(3,3,1); face.position.set(0,14,0); tower.add(face);
  envPut(tower, 96, -30, 0, 0);
}
function populateEnvironment(){
  if(envReady) return; envGroup=new THREE.Group(); scene.add(envGroup);
  populateBankDistrict(); populateMeansMarket(); populateLaborSquare();
  populateFactoryYard(); populateWarehouseDock(); populateSaleMarket();
  populateWorkerDistrict(); populateRoadsideDetails(); populateIndustrialBackground();
  populateWorldDressing();   // v54 : habillage diorama (suit la visibilité par phase via envGroup)
  envReady=true; updateEnvironmentByStage();
}
function updateEnvironmentByStage(){
  if(!envReady) return;
  const live=(typeof gamePhase==='undefined')||gamePhase!=='precapital';
  envGroup.visible=live; if(!live) return;
  const nv=(typeof state!=='undefined'?state.niveauVille:0)||0;
  for(const e of envProps) e.obj.visible = nv >= (e.stage||0);
}
function updateInteractiveProps(dt){
  if(!envReady) return;
  if(typeof gamePhase!=='undefined' && gamePhase==='precapital') {
    return;
  }
  for(const L of envLamps){ if(L&&L.material) L.material.emissiveIntensity=(0.35+0.35*(0.5+0.5*Math.sin(t*3+(L.position?L.position.x:0))))*((typeof DayCycle!=='undefined')?DayCycle.lampBoost:1); }
  const spin=(typeof state!=='undefined'&&state.productionActive)?(0.5+(LivingWorld.ready?LivingWorld.activity:0.3)*3):0;
  for(const g of envGears){ if(g) g.rotation.z+=dt*spin; }
  if(typeof Vehicle==='undefined'||!Vehicle.group) return;
  const vx=Vehicle.pos.x, vz=Vehicle.pos.z, sp=Math.abs(Vehicle.speed);
  for(const p of kickProps){ const o=p.obj; const dx=o.position.x-vx, dz=o.position.z-vz; const d2=dx*dx+dz*dz;
    if(d2<9 && sp>5){ const d=Math.sqrt(d2)||1, f=(sp/26)*0.6; p.vx+=(dx/d)*f; p.vz+=(dz/d)*f; p.vr+=(Math.random()-0.5)*0.5; }
    if(p.vx||p.vz||p.vr){ p.vx*=Math.pow(0.015,dt); p.vz*=Math.pow(0.015,dt); p.vr*=Math.pow(0.04,dt);
      o.position.x=Math.max(-HALF+2,Math.min(HALF-2,o.position.x+p.vx));
      o.position.z=Math.max(-HALF+2,Math.min(HALF-2,o.position.z+p.vz));
      o.rotation.z+=p.vr*dt;
      if(Math.abs(p.vx)<0.0008&&Math.abs(p.vz)<0.0008&&Math.abs(p.vr)<0.0008){ p.vx=p.vz=p.vr=0; } }
  }
}

/* --- petits tweens d'apparition (constructions) --- */
let lwTweens=[];
function animateConstruction(group){
  if(!group) return;
  lwTweens.push({obj:group,born:t,ttl:0.55});
  const entry=Object.entries(zoneGroups).find(([n,g])=>g===group);
  if(entry){ fxPuff(entry[0]); fxHalo(entry[0]); }
}
function updateLwTweens(){
  for(let i=lwTweens.length-1;i>=0;i--){ const w=lwTweens[i]; const k=(t-w.born)/w.ttl;
    if(k>=1){ w.obj.scale.set(1,1,1); lwTweens.splice(i,1); continue; }
    const s=0.82+0.18*(1-Math.pow(1-k,2))+0.07*Math.sin(k*Math.PI);
    w.obj.scale.set(s,s,s);
  }
}

/* --- micro-textes flottants (overlay DOM projeté depuis la 3D) --- */
let floaters=[]; let _floatLayer=null;
const FLOAT_COL={ gain:'#7a6233', perte:'#8a2c1d', social:'#4d5f70', crise:'#8a2c1d', neutre:'#3a3225' };
function floatLayer(){
  if(_floatLayer) return _floatLayer;
  const d=document.createElement('div'); d.id='floaters';
  d.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:25;overflow:hidden;';
  (document.body||document.documentElement).appendChild(d); _floatLayer=d; return d;
}
function floatText(text, worldPos, type='neutre'){
  try{
    const lay=floatLayer(); const el=document.createElement('div'); el.textContent=text;
    const c=FLOAT_COL[type]||FLOAT_COL.neutre;
    el.style.cssText='position:absolute;transform:translate(-50%,-50%);white-space:nowrap;'
      +'font:600 13px "IBM Plex Mono",monospace;color:#e9ddc6;background:'+c+';'
      +'padding:2px 8px;border:1px solid #241f17;box-shadow:2px 2px 0 #241f17;opacity:0;';
    lay.appendChild(el);
    const wp=worldPos||{x:0,z:0};
    const p=new THREE.Vector3(wp.x||0,(wp.y!=null?wp.y:7),wp.z||0);
    floaters.push({el,pos:p,born:t,ttl:1.9});
  }catch(e){}
}
function updateFloaters(){
  if(!floaters.length||!camera) return; const W=innerWidth,H=innerHeight;
  for(let i=floaters.length-1;i>=0;i--){ const f=floaters[i]; const k=(t-f.born)/f.ttl;
    if(k>=1){ if(f.el.remove)f.el.remove(); floaters.splice(i,1); continue; }
    const v=f.pos.clone(); v.y+=k*4; v.project(camera);
    const op=k<0.15?k/0.15:(1-(k-0.15)/0.85);
    f.el.style.left=((v.x*0.5+0.5)*W)+'px'; f.el.style.top=((-v.y*0.5+0.5)*H)+'px';
    f.el.style.opacity=(v.z>1?0:Math.max(0,op)).toFixed(3);
  }
}

const LivingWorld={
  ready:false, grp:null,
  workers:[], crates:[], smoke:[], customers:[], stands:[], lights:[], wagons:[], flows:[], wheel:null,
  _lastDeclenche:false, _lastDette:0, _lastPrix:null, _krachT:-99,

  get activity(){
    if(gamePhase==='precapital') return 0;
    let a=0.18+state.niveauVille*0.10+state.travailleurs*0.02
         +state.niveauMachine*0.06+Math.min(state.stocks/300,0.25);
    if(state.enGreve) a*=0.35;
    if(state.d&&state.d.declenche) a*=0.5;
    return Math.max(0.06,Math.min(1,a));
  },

  mkWorker(col){
    // M-Peuple-proc : routé vers spawnFigure. `col` peut être un hex
    // (LivingWorld) ou un objet legacy. Le tint colore le vêtement.
    const color = (typeof col === 'number') ? col : (col && col.color != null ? col.color : null);
    const g = spawnFigure({ type:'ouvrier', anim:'idle', tint: color });
    g.visible = false; this.grp.add(g); return g;
  },
  mkCrate(){ const m=createCrate(1.5,COL.brun); m.visible=false; this.grp.add(m); return m; },
  /* v60 — la marchandise voyage en chariot : petit chariot + caisse colorée sur le plateau */
  mkCargo(){ const cart=createSmallCart(); const load=createCrate(1.15,COL.brun);
    load.position.set(0,1.55,0); cart.add(load); cart.visible=false; this.grp.add(cart);
    return {cart,load}; },
  mkPuff(){ const m=new THREE.Mesh(new THREE.SphereGeometry(1.3,7,7),
      new THREE.MeshStandardMaterial({color:0x8a8275,transparent:true,opacity:0,flatShading:true}));
    m.visible=false; this.grp.add(m); return m; },
  mkLight(x,y,z){ const m=new THREE.Mesh(new THREE.PlaneGeometry(0.9,1.2),
      new THREE.MeshBasicMaterial({color:0xffd9a0,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide}));
    m.position.set(x,y,z); m.visible=false; this.grp.add(m); return m; },
  mkWagon(){ const m=box(2.4,1.4,1.6,0x4a4236,0,0.7,0,false); m.visible=false; this.grp.add(m); return m; },

  init(){
    if(this.ready) return;
    this.grp=new THREE.Group(); scene.add(this.grp);
    for(let i=0;i<14;i++) this.workers.push({obj:this.mkWorker(i%3?COL.bleu:COL.froid),phase:Math.random()*6.28});
    for(let i=0;i<14;i++){ const cg=this.mkCargo();
      this.crates.push({obj:cg.cart, load:cg.load, p:Math.random(), leg:i%3}); }
    for(let i=0;i<10;i++) this.smoke.push({obj:this.mkPuff(),p:Math.random(),chim:i%2});
    for(let i=0;i<5;i++)  this.customers.push({obj:this.mkWorker(0x7a6f58),phase:Math.random()*6.28});
    const mv=zonePos('Marché de vente'); const cols=[COL.rouge,COL.bleu,COL.vert];
    for(let i=0;i<3;i++){ const g=new THREE.Group();
      g.add(box(2.6,1.6,2,cols[i],0,0.8,0,false)); g.add(box(3,0.5,2.4,0x6b5f4b,0,1.7,0,false));
      g.position.set(mv.x+(i-1)*5.5,0,mv.z-9); g.visible=false; this.grp.add(g); this.stands.push(g); }
    const lspots=[]; const addL=(zn,arr)=>{ const p=zonePos(zn); arr.forEach(o=>lspots.push([p.x+o[0],o[1],p.z+o[2]])); };
    addL('Banque',[[-3,7,5.6],[0,7,5.6],[3,7,5.6],[-3,10,5.6],[3,10,5.6]]);
    addL('Quartier ouvrier',[[-3,3,3.7],[1,3,3.7],[-3,1.4,3.7],[2,3.5,3.7]]);
    addL('Usine',[[-5,4,5.2],[0,4,5.2],[5,4,5.2]]);
    lspots.forEach(s=>this.lights.push({obj:this.mkLight(s[0],s[1],s[2]),phase:Math.random()*6.28}));
    const u=zonePos('Usine');
    this.wheel=new THREE.Mesh(new THREE.TorusGeometry(2.0,0.35,8,16),
      new THREE.MeshStandardMaterial({color:0x4b4438,metalness:.3,roughness:.6,flatShading:true}));
    this.wheel.position.set(u.x+8.5,4.2,u.z+3); this.wheel.visible=false; this.grp.add(this.wheel);
    for(let i=0;i<2;i++) this.wagons.push({obj:this.mkWagon(),p:i*0.5});
    this.debt=createDebtThread(); this.grp.add(this.debt);
    for(let i=0;i<16;i++){ const s=new THREE.Mesh(new THREE.SphereGeometry(0.45,6,6),
        new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:0,depthWrite:false}));
      s.visible=false; this.grp.add(s); this.flows.push({obj:s,active:false,p:0,speed:0.5,h:3,a:{x:0,z:0},b:{x:0,z:0}}); }
    this._lastPrix=state.prixUnitaire;
    this.ready=true;
  },

  update(dt){
    if(!this.ready) return;
    const live=(gamePhase!=='precapital');
    this.grp.visible=live;
    if(!live) return;
    const A=this.activity;
    this.updateWorkers(dt,A);
    this.updateCommodities(dt,A);
    this.updateFactoryActivity(dt,A);
    this.updateSmoke(dt,A);
    this.updateStockVisuals(dt,A);
    this.updateMarketActivity(dt,A);
    this.updateCityPulse(dt,A);
    this.updateCrisisVisuals(dt,A);
    this.updateDebt(dt);
    this.updateFlows(dt);
  },

  updateWorkers(dt,A){
    // M-Peuple : la population (commute, grève visible, chômage) est
    // désormais gérée par PeuplePop — source de vérité unique. On planque
    // simplement le pool LivingWorld pour éviter le double affichage et
    // toute silhouette orpheline.
    for(let i=0;i<this.workers.length;i++){
      const o = this.workers[i] && this.workers[i].obj;
      if(o && o.visible) o.visible = false;
    }
  },

  updateCommodities(dt,A){
    if(!state.productionActive){ this.crates.forEach(c=>c.obj.visible=false); return; }
    const M=zonePos('Marché des moyens'),U=zonePos('Usine'),E=zonePos('Entrepôt'),V=zonePos('Marché de vente');
    const hasEnt=state.buildings.entrepot>0;
    const legs=hasEnt?[[M,U,COL.brun],[U,E,COL.rouge],[E,V,COL.or]]:[[M,U,COL.brun],[U,V,COL.rouge]];
    const nVis=Math.min(this.crates.length,Math.max(2,Math.round(2+A*(VISUAL_LIFE?10*gQual():2))));
    const speed=0.06+A*0.10, risk=(state.d&&state.d.risqueCrise)||0, krach=(t<this._krachT+1.3);
    for(let i=0;i<this.crates.length;i++){ const c=this.crates[i],o=c.obj;
      if(i>=nVis){ o.visible=false; continue; }
      const leg=legs[c.leg%legs.length]; c.p+=speed*dt*(0.7+0.6*((i%3)/2));
      if(c.p>=1){ c.p=0; c.leg=(c.leg+1)%legs.length; }
      const a=leg[0],b=leg[1]; const x=a.x+(b.x-a.x)*c.p, z=a.z+(b.z-a.z)*c.p;
      o.visible=true;
      if(krach){ // v60 : en krach, les chariots versent et s'éparpillent — au sol, pas en l'air
        const kk=(t-this._krachT)/1.3;
        o.position.set(x+(c.sx||0)*kk*14, 0.04, z+(c.sz||0)*kk*14);
        o.rotation.y+=dt*7; o.rotation.z=Math.min(0.9,kk*1.2);
      } else {
        o.position.set(x, 0.04+Math.abs(Math.sin(c.p*40))*0.05, z);   // roulage + cahot léger
        o.rotation.y=Math.atan2(b.x-a.x,b.z-a.z); o.rotation.z=0;
      }
      const col=new THREE.Color(leg[2]);
      if(risk>0.45) col.lerp(new THREE.Color(COL.rouge),Math.min(0.8,(risk-0.45)*1.5));
      if(c.load&&c.load.material) c.load.material.color.copy(col);    // la couleur vit sur la CAISSE
    }
  },

  updateFactoryActivity(dt,A){
    if(!this.wheel) return;
    this.wheel.visible=state.productionActive&&state.niveauMachine>0;
    this.wheel.rotation.z+=dt*(state.enGreve?0:(0.4+A*3.2));
  },

  updateSmoke(dt,A){
    const U=zonePos('Usine'), chim=[[-4,-2],[4,-2]];
    const prod=state.productionActive;
    const dens=state.enGreve?0.12:Math.min(1,0.25+A*0.9+state.niveauMachine*0.05);
    const nP=(!prod)?0:(VISUAL_LIFE?Math.round(this.smoke.length*dens*gQual()):Math.min(3,this.smoke.length));
    const risk=(state.d&&state.d.risqueCrise)||0, dark=risk>0.5||(state.d&&state.d.declenche);
    for(let i=0;i<this.smoke.length;i++){ const s=this.smoke[i],o=s.obj;
      if(i>=nP){ o.visible=false; continue; }
      o.visible=true; s.p+=dt*(0.25+A*0.5); if(s.p>=1) s.p=0;
      const c=chim[s.chim], jit=dark?(Math.sin(i*12.9+t)*0.5+0.5):1;
      o.position.set(U.x+c[0]+Math.sin(t*0.8+i)*0.6,15.5+s.p*7,U.z+c[1]);
      o.scale.setScalar(0.5+s.p*1.4);
      o.material.opacity=Math.max(0,0.5*(1-s.p)*dens*jit);
      o.material.color.setHex(dark?0x4a4438:0x8a8275);
    }
  },

  updateStockVisuals(dt,A){
    const ent=zoneGroups['Entrepôt']; if(!ent) return;
    const sat=state.stocks>180; const red=new THREE.Color(COL.rouge);
    ent.children.forEach(m=>{ if(m.userData&&m.userData.layer==='stock'&&m.material){
      if(sat) m.material.color.lerp(red,0.03);
      m.rotation.y=Math.sin(t*0.6+m.position.x)*0.05; }});
  },

  updateMarketActivity(dt,A){
    // M-Peuple : la clientèle du Marché de vente est gérée par PeuplePop
    // (rôle 'client'). On planque le pool legacy LivingWorld.customers
    // pour éviter le double affichage.
    for(let i=0;i<this.customers.length;i++){
      const o = this.customers[i] && this.customers[i].obj;
      if(o && o.visible) o.visible = false;
    }
    const part=(state.d&&state.d.partJoueur!=null)?state.d.partJoueur:0.4;
    const press=Math.max(0,Math.min(1,1-part*1.4));
    this.stands.forEach((g,i)=>{ const on=press>0.15&&i<Math.ceil(press*3); g.visible=on;
      if(on){ const s=0.6+press*0.6; g.scale.set(s,s,s); } });
  },

  updateCityPulse(dt,A){
    const nLit=Math.round(Math.min(this.lights.length,state.niveauVille*2));
    for(let i=0;i<this.lights.length;i++){ const L=this.lights[i],o=L.obj;
      if(i>=nLit){ o.visible=false; continue; }
      o.visible=true; o.material.opacity=0.22+0.32*(0.5+0.5*Math.sin(t*1.6+L.phase));
    }
    const onRails=state.buildings.rails>0;
    const pts=[zonePos('Usine'),zonePos('Entrepôt'),zonePos('Marché de vente')];
    this.wagons.forEach(w=>{ w.obj.visible=onRails; if(!onRails) return;
      w.p+=dt*(0.05+A*0.06); if(w.p>=1) w.p=0;
      const pp=w.p*2, seg=Math.min(1,Math.floor(pp)), f=pp-seg, a=pts[seg], b=pts[seg+1];
      w.obj.position.set(a.x+(b.x-a.x)*f,0.7,a.z+(b.z-a.z)*f);
      w.obj.rotation.y=Math.atan2(b.x-a.x,b.z-a.z);
    });
  },

  updateDebt(dt){
    if(!this.debt) return; const d=state.dette||0;
    if(d<=0){ this.debt.visible=false; return; }
    this.debt.visible=true; const k=Math.min(1,d/400);
    const col=new THREE.Color(COL.or).lerp(new THREE.Color(COL.rouge),k);
    this.debt.material.color.copy(col);
    this.debt.material.opacity=0.30+0.40*k*(0.65+0.35*Math.sin(t*2));
    const sc=1+k*1.3; this.debt.scale.set(sc,1,sc);
  },
  updateCrisisVisuals(dt,A){
    const decl=!!(state.d&&state.d.declenche);
    if(decl&&!this._lastDeclenche){
      this._krachT=t;
      this.crates.forEach(c=>{ const a=Math.random()*6.28; c.sx=Math.cos(a); c.sz=Math.sin(a); });
      const B=zonePos('Banque'); floatText('krach',{x:B.x,y:16,z:B.z},'crise');
      fxPing('Bourse'); fxPing('Marché de vente');
    }
    this._lastDeclenche=decl;
  },

  updateFlows(dt){
    for(const fl of this.flows){ if(!fl.active) continue;
      fl.p+=dt*fl.speed; if(fl.p>=1){ fl.active=false; fl.obj.visible=false; continue; }
      const pp=Math.max(0,fl.p), x=fl.a.x+(fl.b.x-fl.a.x)*pp, z=fl.a.z+(fl.b.z-fl.a.z)*pp;
      fl.obj.position.set(x,fl.h+Math.sin(pp*Math.PI)*2.5,z);
      fl.obj.material.opacity=fl.p<0?0:0.85*(1-Math.abs(pp-0.5)*1.2);
    }
  },
  spawnFlow(from,to,colorHex,count,hbase){ let n=0;
    for(const fl of this.flows){ if(n>=count) break; if(fl.active) continue;
      fl.active=true; fl.obj.visible=true; fl.a={x:from.x,z:from.z}; fl.b={x:to.x,z:to.z};
      fl.p=-Math.random()*0.25; fl.speed=0.5+Math.random()*0.3; fl.h=hbase||3;
      fl.obj.material.color.setHex(colorHex); n++; }
  },

  // appelé après chaque cycle du moteur : bursts d'argent / marchandises + bulles
  onCycle(){
    if(!this.ready||gamePhase!=='circuit') return;
    const d=state.d||{};
    const V=zonePos('Marché de vente'),B=zonePos('Banque'),U=zonePos('Usine'),Q=zonePos('Quartier ouvrier'),E=zonePos('Entrepôt');
    if((d.unitesVendues||0)>0){ floatText('vente réalisée',{x:V.x,y:7,z:V.z},'gain');
      this.spawnFlow(V,B,0xb8924a,4,3); fxCrate('Entrepôt','Marché de vente'); fxCrate('Usine','Entrepôt'); }
    const dette=state.dette||0;
    if(dette>this._lastDette+0.5){ floatText('dette +'+Math.round(dette-this._lastDette),{x:B.x,y:15,z:B.z},'perte');
      this.spawnFlow(B,U,0xb8924a,3,3); }
    this._lastDette=dette;
    if(state.travailleurs>0) this.spawnFlow(U,Q,0xb8924a,3,3);          // salaires
    if((d.plusValue||0)>0) this.spawnFlow(U,B,0x8a2c1d,3,4);            // plus-value (rouge)
    if((d.invendus||0)>40||state.stocks>120) floatText('stocks saturés',{x:E.x,y:8,z:E.z},'perte');
    if(state.enGreve) floatText('grève',{x:U.x,y:9,z:U.z},'social');
    if(this._lastPrix!=null&&state.prixUnitaire<this._lastPrix-0.001) floatText('prix baisse',{x:V.x,y:9,z:V.z},'perte');
    this._lastPrix=state.prixUnitaire;
  },
};
function updateLivingWorld(dt){ if(LivingWorld.ready) LivingWorld.update(dt); }

// réponse visible à un appui sur E (même sans modale)
function LWmicro(name){
  if(!LivingWorld.ready) return; const p=zonePos(name);
  if(name==='Usine'){ fxPuff('Usine'); fxCrate('Usine',state.buildings.entrepot>0?'Entrepôt':'Marché de vente');
    floatText('la machine tourne',{x:p.x,y:9,z:p.z},'neutre'); }
  else if(name==='Entrepôt'){ fxHalo('Entrepôt'); floatText('stocks : '+Math.round(state.stocks)+' caisses',{x:p.x,y:8,z:p.z},'neutre'); }
  else if(name==='Banque'){ if(state.dette>0){ LivingWorld.spawnFlow(zonePos('Banque'),zonePos('Usine'),0xb8924a,4,3);
      floatText('crédit',{x:p.x,y:9,z:p.z},'perte'); } else floatText('argent avancé',{x:p.x,y:9,z:p.z},'gain'); }
  else if(name==='Marché des moyens'){ fxCrate('Marché des moyens','Usine'); floatText('moyens achetés',{x:p.x,y:8,z:p.z},'neutre'); }
  else if(name==='Marché du travail'){ floatText('embauche',{x:p.x,y:8,z:p.z},'social'); }
}


/* ===================================================================
   M-Peuple — figures de classe stylisées procédurales
   Plus de GLTF : chaque personnage est assemblé à la main à partir de
   ~10 volumes low-poly (bassin, torse, tête, bras×2 segments, jambes×2
   segments, accessoire + outil). Cohérent avec l'esthétique de diorama
   du monde. La CLASSE se lit au premier coup d'œil par :
     • la silhouette (posture, tilt du buste, jupe/redingote/uniforme),
     • la couleur (palette franche, materiel mat flat),
     • l'accessoire (casquette, haut-de-forme, melon, képi, casque mineur),
     • l'outil porté (pelle, marteau, panier, canne, journal).

   API publique :
     • Peuple.init()
     • Peuple.spawnFigure({ type, anim, patrol, tint }) → Object3D
     • Peuple.update(dt) — anime tout, applique le LOD, sweep des morts.

   Le module LIT la simulation via les callsites historiques (updateConse-
   quences, buildSocialTableau, CompetitorWorld, LivingWorld, …) mais
   N'Y ÉCRIT JAMAIS. Pas de caméra, pas de HUD, pas de sol. Émissive
   constante 0.12 (couleur de soi) → visible la nuit sans déclencher le
   bloom (le mineur a 0.35 sur la lampe seulement, < threshold 0.82).
   =================================================================== */
const Peuple = (function(){
  const ANIM_DIST_NEAR = 55;      // < : animation à chaque frame
  const ANIM_DIST_MED  = 110;     // < : 1 frame sur 2
  const ANIM_DIST_FAR  = 200;     // < : 1 frame sur 4 ; > : invisible
  const MAX_FIGURES    = 140;     // garde-fou — au-delà, retourne un Group vide
  const SWEEP_EVERY    = 2.0;     // s — recensement des figures détachées de la scène

  const SKIN = 0xb88a5e;

  // -----------------------------------------------------------------
  // Classes — silhouette + couleur + accessoire + outil + posture.
  // Les couleurs viennent de COLORSCRIPT (palette froide bleu-encre /
  // contrastes chauds pour les outils et la peau).
  // -----------------------------------------------------------------
  // M-Peuple-détail :
  //   Chaque classe = silhouette + posture + costume en VOLUMES superposés.
  //   - cloth / pants : matière principale
  //   - vest : panneau frontal sur torse {col, w, h, dy} (gilet, tablier)
  //   - belt : ceinture/cordon, fine bande au bas du torse
  //   - coat : redingote longue (pans descendant sous la taille)
  //   - collar : col clair visible à la base du cou
  //   - whiskers : favoris (petits volumes mat sombres sur la mâchoire)
  //   - beard : barbe (petit volume sous le menton)
  //   - shoeColor / shoeBig : couleur et taille des chaussures/bottes
  //   - headSlump : fait pencher la tête (chomeur affaissé)
  const CLASS_DEFS = {
    ouvrier:       { cloth:0x4d5f70, pants:0x2a241c, hat:'casquette',
                     tool:'pelle',     tilt: 0.14, sleevesRoll:true,    // voûté
                     vest:{col:0x3a4858,w:0.36,h:0.42,dy:0.22},
                     belt:0x231a12, capLow:true,                       // casquette qui ombre le visage
                     shoeColor:0x16100c, shoeBig:true },
    ouvriere:      { cloth:0x445064, pants:0x33291d, hat:'fichu',
                     tool:'panier',    tilt: 0.05, skirt:true, skirtFlared:true,
                     apron:{col:0xc9b78c,w:0.30,h:0.30,dy:0.16},
                     hairBack:0x3a2a1c,                                // mèche derrière le fichu
                     shoeColor:0x2a201a },
    chomeur:       { cloth:0x5b5346, pants:0x3a3128, hat:'casquette',
                     hatColor:0x2a261f, tool:null,  tilt: 0.24,         // épaules tombantes
                     belt:0x2a2018, headSlump:true, capLow:true,
                     scarf:0x6b3d33,
                     shoeColor:0x18120e },
    capitaliste:   { cloth:0x222229, pants:0x16161a, hat:'cylindre',
                     tool:'canne',     tilt:-0.10,                      // cambré : torse en arrière
                     coat:{col:0x222229,len:0.55,w:0.44},
                     vest:{col:0xc9a85e,w:0.26,h:0.30,dy:0.16},
                     collar:0xe2dabd, whiskers:true, mustache:0x2a221c,
                     shoeColor:0x0a0808, shoeBig:true },
    bourgeois:     { cloth:0x6e6e7a, pants:0x3e3a36, hat:'melon',
                     tool:'journal',   tilt: 0.00,
                     vest:{col:0xc4b691,w:0.24,h:0.28,dy:0.14},
                     collar:0xe2dabd, whiskers:true, mustache:0x3a2f24,
                     shoeColor:0x1a1410 },
    mineur:        { cloth:0x3a342e, pants:0x2a2622, hat:'casque-mineur',
                     tool:'pioche',    tilt: 0.16, sleevesRoll:true,    // pioche !
                     vest:{col:0x261f1a,w:0.30,h:0.34,dy:0.18},
                     belt:0x141008,
                     shoeColor:0x0c0805, shoeBig:true },
    fonctionnaire: { cloth:0x2a3140, pants:0x1a1f28, hat:'kepi',
                     tool:null,        tilt:-0.04,                      // raide, légèrement cambré
                     vest:{col:0xa8812c,w:0.06,h:0.40,dy:0.08},
                     belt:0x0a0d12, collar:0xb8b09a,
                     shoeColor:0x080808 },
    paysan:        { cloth:0x8a7a52, pants:0x4a3826, hat:'paille',
                     tool:'faux',      tilt: 0.18, sleevesRoll:true,
                     belt:0x5a4220, beard:0x5a4030, mustache:0x5a4030,
                     shoeColor:0x4a3625, shoeBig:true },
    marchand:      { cloth:0x6b513a, pants:0x3a2618, hat:'calot',
                     tool:null,        tilt: 0.04, sleevesRoll:true,
                     apron:{col:0xb0a07a,w:0.34,h:0.38,dy:0.18},
                     belt:0x4a3a26,
                     cuffs:0xc9b78c,                                    // manchettes claires
                     shoeColor:0x2a1f15 },
  };

  // Petites variations PAR INSTANCE (pas deux ouvriers identiques).
  // 3 nuances proches par classe — partagées via _matCache, ZÉRO alloc.
  const _CLOTH_VARIANTS = {
    ouvrier:    [0x4d5f70, 0x42566a, 0x556678],
    ouvriere:   [0x445064, 0x3c4a5e, 0x4c5870],
    chomeur:    [0x5b5346, 0x5a4d44, 0x4f4738],
    capitaliste:[0x222229, 0x1c1c22, 0x2c2a34],
    bourgeois:  [0x6e6e7a, 0x666673, 0x767584],
    mineur:     [0x3a342e, 0x342f29, 0x40382f],
    fonctionnaire:[0x2a3140, 0x222936, 0x303849],
    paysan:     [0x8a7a52, 0x8b7b4a, 0x826f48],
    marchand:   [0x6b513a, 0x715838, 0x624a36],
  };
  function _pickCloth(type, def, opts){
    if(opts && opts.tint != null) return opts.tint;     // override par firme
    const vs = _CLOTH_VARIANTS[type];
    return vs ? vs[(Math.random()*vs.length)|0] : def.cloth;
  }

  // -----------------------------------------------------------------
  // Matériaux & géométries partagés. ZÉRO allocation par frame.
  // -----------------------------------------------------------------
  const _matCache = new Map();
  function _mat(hex){
    let m = _matCache.get(hex);
    if(!m){
      m = new THREE.MeshStandardMaterial({
        color: hex,
        emissive: new THREE.Color(hex),
        emissiveIntensity: 0.12,        // < threshold bloom 0.82 — pas de fleur
        roughness: 0.85, metalness: 0.0,
        flatShading: true,
      });
      _matCache.set(hex, m);
    }
    return m;
  }
  const _emiMatCache = new Map();
  function _emiMat(color, emissive){
    const key = color + '|' + emissive;
    let m = _emiMatCache.get(key);
    if(!m){
      m = new THREE.MeshStandardMaterial({
        color, emissive: new THREE.Color(emissive),
        emissiveIntensity: 0.35,
        roughness: 0.7, metalness: 0.0, flatShading: true,
      });
      _emiMatCache.set(key, m);
    }
    return m;
  }
  const _geo = {};
  function _g(key, ctor){ if(!_geo[key]) _geo[key] = ctor(); return _geo[key]; }

  // -----------------------------------------------------------------
  // Pièces de corps. Pieds à y=0, hauteur totale ~1.80 u.
  // -----------------------------------------------------------------
  function _makeArm(clothHex, sleevesRoll, cuffHex){
    // upper = pivot épaule ; fore = pivot coude ; hand = pivot poignet.
    const upper = new THREE.Group();
    const upperMesh = new THREE.Mesh(
      _g('arm_upper', ()=> new THREE.BoxGeometry(0.10, 0.36, 0.10)),
      _mat(clothHex));
    upperMesh.position.y = -0.18;
    upper.add(upperMesh);
    const fore = new THREE.Group();
    fore.position.y = -0.36;
    const foreColor = sleevesRoll ? SKIN : clothHex;
    const foreMesh = new THREE.Mesh(
      _g('arm_fore', ()=> new THREE.BoxGeometry(0.09, 0.32, 0.09)),
      _mat(foreColor));
    foreMesh.position.y = -0.16;
    fore.add(foreMesh);
    // MANCHETTES — petit volume contrastant au poignet (marchand).
    if(cuffHex != null){
      const cuff = new THREE.Mesh(
        _g('cuff', ()=> new THREE.BoxGeometry(0.105, 0.05, 0.105)),
        _mat(cuffHex));
      cuff.position.y = -0.30;
      fore.add(cuff);
    }
    const hand = new THREE.Mesh(
      _g('hand', ()=> new THREE.BoxGeometry(0.10, 0.09, 0.10)),
      _mat(SKIN));
    hand.position.y = -0.36;
    fore.add(hand);
    upper.add(fore);
    upper.userData = { fore, hand };
    return upper;
  }
  function _makeLeg(pantsHex, shoeHex, shoeBig){
    const thigh = new THREE.Group();
    const thighMesh = new THREE.Mesh(
      _g('leg_thigh', ()=> new THREE.BoxGeometry(0.14, 0.40, 0.14)),
      _mat(pantsHex));
    thighMesh.position.y = -0.20;
    thigh.add(thighMesh);
    const shin = new THREE.Group();
    shin.position.y = -0.40;
    const shinMesh = new THREE.Mesh(
      _g('leg_shin', ()=> new THREE.BoxGeometry(0.13, 0.38, 0.13)),
      _mat(pantsHex));
    shinMesh.position.y = -0.19;
    shin.add(shinMesh);
    // M-Peuple-détail : chaussure normale OU grosse botte/sabot.
    const shoeGeo = shoeBig
      ? _g('shoe_big', ()=> new THREE.BoxGeometry(0.19, 0.10, 0.24))
      : _g('shoe',     ()=> new THREE.BoxGeometry(0.16, 0.07, 0.22));
    const shoe = new THREE.Mesh(shoeGeo, _mat(shoeHex != null ? shoeHex : 0x1a1612));
    shoe.position.set(0, shoeBig ? -0.40 : -0.41, 0.04);
    shin.add(shoe);
    // Suggestion de talon : bandeau fin plus sombre à l'arrière.
    if(shoeBig){
      const heel = new THREE.Mesh(
        _g('shoe_heel', ()=> new THREE.BoxGeometry(0.19, 0.05, 0.07)),
        _mat(0x0a0805));
      heel.position.set(0, -0.42, -0.06);
      shin.add(heel);
    }
    thigh.add(shin);
    thigh.userData = { shin };
    return thigh;
  }
  function _makeHat(kind, hatColor){
    // Espace LOCAL du headGroup ; sommet du crâne ≈ y=0.23.
    const g = new THREE.Group();
    if(kind==='casquette'){
      const col = hatColor || 0x1c1c20;
      const calotte = new THREE.Mesh(
        _g('cap_top', ()=> new THREE.CylinderGeometry(0.135, 0.135, 0.06, 10)),
        _mat(col));
      calotte.position.y = 0.26;
      const visor = new THREE.Mesh(
        _g('cap_visor', ()=> new THREE.BoxGeometry(0.22, 0.025, 0.10)),
        _mat(col));
      visor.position.set(0, 0.24, 0.14);
      g.add(calotte); g.add(visor);
    } else if(kind==='cylindre'){
      const col = 0x0c0c10;
      const corps = new THREE.Mesh(
        _g('hat_top', ()=> new THREE.CylinderGeometry(0.11, 0.11, 0.22, 12)),
        _mat(col));
      corps.position.y = 0.36;
      const brim = new THREE.Mesh(
        _g('hat_brim', ()=> new THREE.CylinderGeometry(0.18, 0.18, 0.02, 14)),
        _mat(col));
      brim.position.y = 0.24;
      g.add(corps); g.add(brim);
    } else if(kind==='melon'){
      const col = 0x2a282e;
      const dome = new THREE.Mesh(
        _g('melon_dome', ()=> new THREE.SphereGeometry(0.13, 10, 8, 0, Math.PI*2, 0, Math.PI/2)),
        _mat(col));
      dome.position.y = 0.23;
      const brim = new THREE.Mesh(
        _g('melon_brim', ()=> new THREE.CylinderGeometry(0.16, 0.16, 0.015, 14)),
        _mat(col));
      brim.position.y = 0.23;
      g.add(dome); g.add(brim);
    } else if(kind==='fichu'){
      const col = hatColor || 0x3a3140;
      const tissu = new THREE.Mesh(
        _g('fichu_dome', ()=> new THREE.SphereGeometry(0.15, 10, 8, 0, Math.PI*2, 0, Math.PI*0.62)),
        _mat(col));
      tissu.position.y = 0.16;
      g.add(tissu);
      const drape = new THREE.Mesh(
        _g('fichu_drape', ()=> new THREE.BoxGeometry(0.18, 0.14, 0.04)),
        _mat(col));
      drape.position.set(0, 0.04, -0.13);
      g.add(drape);
    } else if(kind==='kepi'){
      const col = 0x1a1f28;
      const cyl = new THREE.Mesh(
        _g('kepi_cyl', ()=> new THREE.CylinderGeometry(0.13, 0.13, 0.10, 12)),
        _mat(col));
      cyl.position.y = 0.28;
      const top = new THREE.Mesh(
        _g('kepi_top', ()=> new THREE.CylinderGeometry(0.135, 0.135, 0.03, 12)),
        _mat(col));
      top.position.y = 0.34;
      const visor = new THREE.Mesh(
        _g('cap_visor', ()=> new THREE.BoxGeometry(0.22, 0.025, 0.10)),
        _mat(col));
      visor.position.set(0, 0.23, 0.14);
      g.add(cyl); g.add(top); g.add(visor);
    } else if(kind==='casque-mineur'){
      const col = 0x2c2620;
      const dome = new THREE.Mesh(
        _g('helmet_dome', ()=> new THREE.SphereGeometry(0.14, 10, 8, 0, Math.PI*2, 0, Math.PI/2)),
        _mat(col));
      dome.position.y = 0.22;
      const lampe = new THREE.Mesh(
        _g('lamp_bulb', ()=> new THREE.SphereGeometry(0.035, 8, 6)),
        _emiMat(0xffd9a0, COLORSCRIPT.gasLight));
      lampe.position.set(0, 0.22, 0.15);
      g.add(dome); g.add(lampe);
    } else if(kind==='paille'){
      // CHAPEAU DE PAILLE — cône bas large clair (paysan).
      const col = hatColor || 0xc9a85e;
      const cone = new THREE.Mesh(
        _g('straw_cone', ()=> new THREE.ConeGeometry(0.24, 0.12, 12)),
        _mat(col));
      cone.position.y = 0.27;
      const ribbon = new THREE.Mesh(
        _g('straw_ribbon', ()=> new THREE.CylinderGeometry(0.13, 0.13, 0.025, 12)),
        _mat(0x6b4f30));
      ribbon.position.y = 0.24;
      g.add(cone); g.add(ribbon);
    } else if(kind==='calot'){
      // CALOT de commerce / petit chapeau plat sans bord (marchand).
      const col = hatColor || 0x4a3a26;
      const calotte = new THREE.Mesh(
        _g('calot_top', ()=> new THREE.CylinderGeometry(0.130, 0.135, 0.075, 10)),
        _mat(col));
      calotte.position.y = 0.27;
      g.add(calotte);
    }
    return g;
  }
  function _makeTool(kind){
    const g = new THREE.Group();
    if(kind==='pelle'){
      const stick = new THREE.Mesh(
        _g('shovel_stick', ()=> new THREE.BoxGeometry(0.035, 0.65, 0.035)),
        _mat(0x6b4f30));
      const blade = new THREE.Mesh(
        _g('shovel_blade', ()=> new THREE.BoxGeometry(0.16, 0.18, 0.025)),
        _mat(0x4a4236));
      stick.position.y = -0.30;
      blade.position.y = -0.62;
      g.add(stick); g.add(blade);
    } else if(kind==='marteau'){
      const stick = new THREE.Mesh(
        _g('hammer_stick', ()=> new THREE.BoxGeometry(0.035, 0.40, 0.035)),
        _mat(0x6b4f30));
      const head = new THREE.Mesh(
        _g('hammer_head', ()=> new THREE.BoxGeometry(0.16, 0.06, 0.06)),
        _mat(0x3a342e));
      stick.position.y = -0.20;
      head.position.y = -0.40;
      g.add(stick); g.add(head);
    } else if(kind==='panier'){
      const basket = new THREE.Mesh(
        _g('basket', ()=> new THREE.CylinderGeometry(0.14, 0.10, 0.16, 10)),
        _mat(0x8a6b3a));
      basket.position.y = -0.18;
      g.add(basket);
    } else if(kind==='canne'){
      const stick = new THREE.Mesh(
        _g('cane', ()=> new THREE.BoxGeometry(0.025, 0.60, 0.025)),
        _mat(0x1a1612));
      stick.position.y = -0.30;
      g.add(stick);
    } else if(kind==='journal'){
      const paper = new THREE.Mesh(
        _g('newspaper', ()=> new THREE.BoxGeometry(0.16, 0.20, 0.02)),
        _mat(0xc9c2a8));
      paper.position.y = -0.15;
      paper.rotation.x = 0.4;
      g.add(paper);
    } else if(kind==='faux'){
      // FAUX — long manche brun + lame courbe en biais (paysan).
      const stick = new THREE.Mesh(
        _g('scythe_stick', ()=> new THREE.BoxGeometry(0.035, 0.85, 0.035)),
        _mat(0x6b4f30));
      stick.position.y = -0.36;
      stick.rotation.z = 0.10;
      const blade = new THREE.Mesh(
        _g('scythe_blade', ()=> new THREE.BoxGeometry(0.04, 0.06, 0.45)),
        _mat(0x9ca5ad));
      blade.position.set(0.06, -0.78, 0.22);
      blade.rotation.x = -0.55;
      g.add(stick); g.add(blade);
    } else if(kind==='pioche'){
      // PIOCHE — manche court + tête en T perpendiculaire (mineur).
      const stick = new THREE.Mesh(
        _g('pick_stick', ()=> new THREE.BoxGeometry(0.035, 0.55, 0.035)),
        _mat(0x6b4f30));
      stick.position.y = -0.26;
      const head = new THREE.Mesh(
        _g('pick_head', ()=> new THREE.BoxGeometry(0.40, 0.06, 0.07)),
        _mat(0x3a342e));
      head.position.y = -0.52;
      // pointe affûtée d'un côté
      const tip = new THREE.Mesh(
        _g('pick_tip', ()=> new THREE.BoxGeometry(0.06, 0.05, 0.06)),
        _mat(0x4a4338));
      tip.position.set(0.22, -0.52, 0);
      g.add(stick); g.add(head); g.add(tip);
    }
    return g;
  }

  // -----------------------------------------------------------------
  // buildFigure(type) — assemble le perso. Pieds à y=0, ~1.80 u.
  // userData expose les pivots animables.
  // M-Peuple-détail : silhouette enrichie en VOLUMES superposés
  //   (épaules-yoke, cou, vest/tablier/redingote, ceinture, col,
  //   favoris/barbe), variantes de teinte par instance, sabots/bottes.
  // -----------------------------------------------------------------
  function buildFigure(type, opts){
    const def = CLASS_DEFS[type] || CLASS_DEFS.ouvrier;
    const cloth = _pickCloth(type, def, opts);          // variante d'instance
    const root = new THREE.Group();
    root.name = 'Peuple:' + type;

    // BASSIN (haut des cuisses ≈ 0.85 u).
    const pelvis = new THREE.Mesh(
      _g('pelvis', ()=> new THREE.BoxGeometry(0.32, 0.22, 0.22)),
      _mat(def.pants));
    pelvis.position.y = 0.85;
    root.add(pelvis);

    // TORSE — Group pivot au sommet du bassin, tilt par classe.
    const torso = new THREE.Group();
    torso.position.y = 0.95;
    torso.rotation.x = def.tilt || 0;
    const torsoMesh = new THREE.Mesh(
      _g('torso', ()=> new THREE.BoxGeometry(0.44, 0.55, 0.26)),
      _mat(cloth));
    torsoMesh.position.y = 0.28;
    torso.add(torsoMesh);

    // ÉPAULES-YOKE — bandeau plat plus large que le torse, en haut.
    //   Donne du caractère à la silhouette (épaules marquées low-poly).
    const yoke = new THREE.Mesh(
      _g('yoke', ()=> new THREE.BoxGeometry(0.52, 0.07, 0.28)),
      _mat(cloth));
    yoke.position.y = 0.53;
    torso.add(yoke);

    // CEINTURE — bande horizontale fine au bas du torse.
    if(def.belt != null){
      const belt = new THREE.Mesh(
        _g('belt', ()=> new THREE.BoxGeometry(0.46, 0.05, 0.28)),
        _mat(def.belt));
      belt.position.y = 0.03;
      torso.add(belt);
    }

    // GILET / TABLIER / BANDOULIÈRE — panneau frontal en sur-volume.
    //   Posé sur le torse, légèrement avant (+Z) pour lever le z-fighting.
    //   Géométrie UNITAIRE partagée (1×1×0.04), scale par mesh : ZÉRO
    //   géo créée par instance.
    const panel = def.vest || def.apron;
    if(panel){
      const front = new THREE.Mesh(
        _g('panel_unit', ()=> new THREE.BoxGeometry(1, 1, 0.04)),
        _mat(panel.col));
      front.scale.set(panel.w, panel.h, 1);
      front.position.set(0, panel.dy, 0.145);
      torso.add(front);
    }

    // REDINGOTE — pans longs qui descendent sous la taille (capitaliste).
    //   Volume qui prolonge le torse, indépendant des jambes (donc reste
    //   immobile pendant la marche — assumé, le bourgeois "glisse").
    //   Géométrie unitaire partagée, scale par mesh.
    if(def.coat){
      const tail = new THREE.Mesh(
        _g('coat_unit', ()=> new THREE.BoxGeometry(1, 1, 0.20)),
        _mat(def.coat.col));
      tail.scale.set(def.coat.w, def.coat.len, 1);
      tail.position.set(0, -def.coat.len*0.5 + 0.02, -0.02);
      torso.add(tail);
    }

    // COL CLAIR — petit liseré sous le menton.
    if(def.collar != null){
      const collar = new THREE.Mesh(
        _g('collar', ()=> new THREE.BoxGeometry(0.20, 0.05, 0.20)),
        _mat(def.collar));
      collar.position.y = 0.59;
      torso.add(collar);
    }

    // COU — petit volume entre torse et tête.
    const neck = new THREE.Mesh(
      _g('neck', ()=> new THREE.BoxGeometry(0.10, 0.07, 0.10)),
      _mat(SKIN));
    neck.position.y = 0.59;
    torso.add(neck);

    // FOULARD (chomeur) — bandeau coloré autour du cou, posture misère.
    if(def.scarf != null){
      const scarf = new THREE.Mesh(
        _g('scarf', ()=> new THREE.BoxGeometry(0.22, 0.06, 0.18)),
        _mat(def.scarf));
      scarf.position.y = 0.57;
      torso.add(scarf);
    }

    root.add(torso);

    // TÊTE — crâne ovoïde FACETTÉ (8×6 segs, flatShading) + traits
    //   stylisés (yeux/nez/bouche) en petits volumes mats. Chomeur
    //   affaissé : tête plus basse. PAS de visage réaliste — juste des
    //   suggestions low-poly qui donnent du caractère sans rompre l'unité.
    const head = new THREE.Group();
    head.position.y = def.headSlump ? 0.58 : 0.62;
    const headMesh = new THREE.Mesh(
      _g('head', ()=> new THREE.SphereGeometry(0.13, 8, 6)),    // moins lisse → facettes visibles
      _mat(SKIN));
    headMesh.scale.set(1.0, 1.18, 0.95);
    headMesh.position.y = 0.08;
    head.add(headMesh);

    // YEUX — deux petits cubes mats sombres incrustés dans la face.
    const EYE_DARK = 0x1a1612;
    for(const sx of [-1, 1]){
      const eye = new THREE.Mesh(
        _g('eye', ()=> new THREE.BoxGeometry(0.028, 0.028, 0.020)),
        _mat(EYE_DARK));
      eye.position.set(sx*0.045, 0.10, 0.110);
      head.add(eye);
    }
    // NEZ — petit volume sortant (la pointe la plus en avant).
    const nose = new THREE.Mesh(
      _g('nose', ()=> new THREE.BoxGeometry(0.030, 0.045, 0.040)),
      _mat(SKIN));
    nose.position.set(0, 0.065, 0.135);
    head.add(nose);
    // BOUCHE — fine bande sombre, posée sur le devant.
    const mouth = new THREE.Mesh(
      _g('mouth', ()=> new THREE.BoxGeometry(0.050, 0.012, 0.020)),
      _mat(0x3a261c));
    mouth.position.set(0, 0.005, 0.118);
    head.add(mouth);
    if(def.headSlump) head.rotation.x = 0.20;            // menton bas
    torso.add(head);
    if(def.hat){
      const hatGroup = _makeHat(def.hat, def.hatColor);
      // CASQUETTE BAISSÉE — visière qui plonge, ombre le visage (ouvrier/chomeur).
      if(def.capLow) hatGroup.rotation.x = -0.22;
      head.add(hatGroup);
    }

    // FAVORIS — deux petits volumes mat sombres collés à la mâchoire.
    if(def.whiskers){
      const wc = 0x3a2f24;
      for(const sx of [-1, 1]){
        const w = new THREE.Mesh(
          _g('whisker', ()=> new THREE.BoxGeometry(0.05, 0.07, 0.07)),
          _mat(wc));
        w.position.set(sx*0.12, 0.04, 0.04);
        head.add(w);
      }
    }
    // MOUSTACHE — petit volume horizontal sous le nez (bourgeois, capitaliste,
    // paysan). Largeur < favoris, posé sur le devant du visage.
    if(def.mustache != null){
      const must = new THREE.Mesh(
        _g('mustache', ()=> new THREE.BoxGeometry(0.10, 0.025, 0.04)),
        _mat(def.mustache));
      must.position.set(0, 0.045, 0.115);
      head.add(must);
    }
    // BARBE (paysan) — petit volume sous le menton.
    if(def.beard != null){
      const beard = new THREE.Mesh(
        _g('beard', ()=> new THREE.BoxGeometry(0.13, 0.07, 0.05)),
        _mat(def.beard));
      beard.position.set(0, 0.01, 0.10);
      head.add(beard);
    }
    // MÈCHE DERRIÈRE LE FICHU (ouvrière) — petit chignon visible à l'arrière.
    if(def.hairBack != null){
      const hair = new THREE.Mesh(
        _g('hair_back', ()=> new THREE.BoxGeometry(0.18, 0.10, 0.08)),
        _mat(def.hairBack));
      hair.position.set(0, 0.04, -0.10);
      head.add(hair);
    }

    // BRAS — pivots aux épaules (suivent le tilt du buste).
    const armL = _makeArm(cloth, def.sleevesRoll, def.cuffs);
    armL.position.set(-0.26, 0.55, 0);
    torso.add(armL);
    const armR = _makeArm(cloth, def.sleevesRoll, def.cuffs);
    armR.position.set( 0.26, 0.55, 0);
    torso.add(armR);

    // OUTIL — dans la main droite.
    if(def.tool){
      const tool = _makeTool(def.tool);
      armR.userData.hand.add(tool);
    }

    // JAMBES — sur le root (indépendantes du tilt du buste).
    const legL = _makeLeg(def.pants, def.shoeColor, def.shoeBig);
    legL.position.set(-0.10, 0.85, 0);
    root.add(legL);
    const legR = _makeLeg(def.pants, def.shoeColor, def.shoeBig);
    legR.position.set( 0.10, 0.85, 0);
    root.add(legR);

    // JUPE / ROBE (ouvrière) — drape évasée sur les cuisses, mollets
    // visibles. skirtFlared : robe plus longue et plus large à la base.
    if(def.skirt){
      const skirt = new THREE.Mesh(
        def.skirtFlared
          ? _g('skirt_flared', ()=> new THREE.CylinderGeometry(0.22, 0.40, 0.65, 12, 1, true))
          : _g('skirt',        ()=> new THREE.CylinderGeometry(0.22, 0.32, 0.55, 12, 1, true)),
        _mat(cloth));
      skirt.position.y = def.skirtFlared ? 0.55 : 0.60;
      root.add(skirt);
    }

    root.userData = {
      type, def,
      armL, armR,
      foreL: armL.userData.fore, foreR: armR.userData.fore,
      legL, legR,
      shinL: legL.userData.shin, shinR: legR.userData.shin,
      head, torso,
      baseY: 0,
      phase: Math.random() * 6.2831853,
      speed: 0.85 + Math.random() * 0.30,
      anim: 'idle',
      patrol: null, patrolT: 0,
      lodTick: 0,
      idleLook: Math.random() * 6.28,
      _autoHidden: false,
    };
    return root;
  }

  // -----------------------------------------------------------------
  // Animation procédurale — 4 boucles via uTime partagé. Zéro alloc.
  // -----------------------------------------------------------------
  function _animate(fig, t){
    const u = fig.userData;
    const ph = u.phase;
    const sp = u.speed;
    const def = u.def;
    const tiltBase = def.tilt || 0;
    const anim = u.anim;

    if(anim === 'walk'){
      const w = t * 6 * sp + ph;
      const swing = Math.sin(w) * 0.55;
      u.legL.rotation.x = swing;
      u.legR.rotation.x = -swing;
      u.shinL.rotation.x = Math.max(0, -swing * 0.55);
      u.shinR.rotation.x = Math.max(0,  swing * 0.55);
      u.armL.rotation.x = -swing * 0.45;
      u.armR.rotation.x =  swing * 0.45;
      u.armL.rotation.z = 0; u.armR.rotation.z = 0;
      u.foreL.rotation.x =  swing * 0.30;
      u.foreR.rotation.x = -swing * 0.30;
      u.torso.rotation.x = tiltBase;
      u.torso.rotation.y = 0; u.torso.rotation.z = 0;
      u.head.rotation.y = 0;
      fig.position.y = u.baseY + Math.abs(Math.cos(w)) * 0.04;
    } else if(anim === 'work'){
      const w = t * 3.2 * sp + ph;
      const s = Math.sin(w);
      u.armR.rotation.x = -0.30 + s * 0.85;
      u.armL.rotation.x = -0.20 + s * 0.55;
      u.armR.rotation.z = 0; u.armL.rotation.z = 0;
      u.foreR.rotation.x = -0.55 - s * 0.40;
      u.foreL.rotation.x = -0.45 - s * 0.30;
      u.torso.rotation.x = tiltBase + s * 0.05;
      u.torso.rotation.y = s * 0.10;
      u.torso.rotation.z = 0;
      u.legL.rotation.x =  0.05;
      u.legR.rotation.x = -0.05;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = 0;
      fig.position.y = u.baseY;
    } else if(anim === 'angry'){
      const w = t * 4 * sp + ph;
      const s = Math.sin(w);
      u.armR.rotation.z = -2.0 + s * 0.20;          // bras levé droit
      u.armR.rotation.x = -0.25;
      u.foreR.rotation.x = -1.10;
      u.armL.rotation.x = Math.sin(w + 1.1) * 0.45;
      u.armL.rotation.z = 0;
      u.foreL.rotation.x = -0.55;
      u.torso.rotation.x = tiltBase + Math.sin(t * 3 + ph) * 0.04;
      u.torso.rotation.y = 0;
      u.torso.rotation.z = 0;
      u.legL.rotation.x = 0; u.legR.rotation.x = 0;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = Math.sin(w * 0.7) * 0.20;
      fig.position.y = u.baseY;
    } else if(anim === 'farm'){
      // paysan : labour/fauchage — torse penché, bras qui balayent.
      const w = t * 2.6 * sp + ph;
      const s = Math.sin(w);
      u.torso.rotation.x = tiltBase + 0.42 + s * 0.06;
      u.torso.rotation.y = s * 0.22;
      u.torso.rotation.z = 0;
      u.armR.rotation.x = -0.80 + s * 0.70;
      u.armR.rotation.z = 0;
      u.armL.rotation.x = -0.55 - s * 0.45;
      u.armL.rotation.z = 0;
      u.foreR.rotation.x = -0.55;
      u.foreL.rotation.x = -0.30;
      u.legL.rotation.x = 0.06; u.legR.rotation.x = -0.04;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = 0;
      fig.position.y = u.baseY;
    } else if(anim === 'sell'){
      // marchand debout derrière son étal — hèle le client (bras qui se lève).
      const w = t * 1.6 * sp + ph;
      const s = Math.sin(w);
      const raise = Math.max(0, s);
      u.torso.rotation.x = tiltBase;
      u.torso.rotation.y = 0;
      u.torso.rotation.z = 0;
      u.armR.rotation.x = -0.50 - raise * 1.30;
      u.armR.rotation.z = -0.25 - raise * 0.45;
      u.foreR.rotation.x = -0.30 - raise * 0.55;
      u.armL.rotation.x = Math.sin(w * 0.7) * 0.06;
      u.armL.rotation.z = 0;
      u.foreL.rotation.x = -0.10;
      u.legL.rotation.x = 0; u.legR.rotation.x = 0;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = Math.sin(w * 0.55) * 0.28;
      fig.position.y = u.baseY;
    } else if(anim === 'watch'){
      // capitaliste / surveille — bras croisés, regard tournant.
      const w = t * 0.9 + ph;
      u.torso.rotation.x = tiltBase;
      u.torso.rotation.y = Math.sin(w * 0.5) * 0.06;
      u.torso.rotation.z = 0;
      u.armR.rotation.x = -0.22;
      u.armR.rotation.z =  1.10;
      u.foreR.rotation.x = -1.20;
      u.armL.rotation.x = -0.22;
      u.armL.rotation.z = -1.10;
      u.foreL.rotation.x = -1.20;
      u.legL.rotation.x = 0; u.legR.rotation.x = 0;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = Math.sin(w * 0.4) * 0.55;
      fig.position.y = u.baseY;
    } else if(anim === 'stroll'){
      // bourgeois — marche lente, journal en main, peu de balancement.
      const w = t * 3.0 * sp + ph;
      const swing = Math.sin(w) * 0.30;
      u.legL.rotation.x = swing;
      u.legR.rotation.x = -swing;
      u.shinL.rotation.x = Math.max(0, -swing * 0.45);
      u.shinR.rotation.x = Math.max(0,  swing * 0.45);
      u.armL.rotation.x = -swing * 0.18;
      u.armR.rotation.x =  swing * 0.18;
      u.armL.rotation.z = 0; u.armR.rotation.z = 0;
      u.foreL.rotation.x = 0; u.foreR.rotation.x = -0.45;     // tient le journal
      u.torso.rotation.x = tiltBase;
      u.torso.rotation.y = 0;
      u.head.rotation.y = Math.sin(t * 0.4 + u.idleLook) * 0.22;
      fig.position.y = u.baseY + Math.abs(Math.cos(w)) * 0.025;
    } else if(anim === 'drive'){
      // M-Peuple-détail-b : COCHER — assis/debout à l'avant du chariot,
      //   deux mains tenant les rênes/la barre, léger balancement.
      const w = t * 1.1 + ph;
      u.torso.rotation.x = tiltBase + 0.05;
      u.torso.rotation.y = Math.sin(w) * 0.025;
      u.torso.rotation.z = 0;
      // bras tendus en avant à hauteur de poitrine, mains côte à côte.
      u.armR.rotation.x = -1.25 + Math.sin(w * 0.7) * 0.04;
      u.armR.rotation.z = -0.15;
      u.foreR.rotation.x = -0.55;
      u.armL.rotation.x = -1.25 + Math.sin(w * 0.7 + 0.4) * 0.04;
      u.armL.rotation.z =  0.15;
      u.foreL.rotation.x = -0.55;
      u.legL.rotation.x = 0; u.legR.rotation.x = 0;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = Math.sin(w * 0.5) * 0.05;
      fig.position.y = u.baseY;
    } else if(anim === 'sit'){
      // chomeur oisif — assis au bord de l'eau, buste penché.
      u.torso.rotation.x = tiltBase + 0.28;
      u.torso.rotation.y = 0;
      u.torso.rotation.z = 0;
      u.armR.rotation.x = -1.05; u.armR.rotation.z = 0; u.foreR.rotation.x = -0.60;
      u.armL.rotation.x = -1.05; u.armL.rotation.z = 0; u.foreL.rotation.x = -0.60;
      u.legL.rotation.x = -1.35; u.legR.rotation.x = -1.35;
      u.shinL.rotation.x =  1.45; u.shinR.rotation.x =  1.45;
      const w = t * 0.6 + ph;
      u.head.rotation.y = Math.sin(w) * 0.18;
      fig.position.y = u.baseY - 0.55;
    } else {
      // idle : léger balancement, tête qui se tourne parfois.
      const w = t * 1.4 + ph;
      u.torso.rotation.x = tiltBase;
      u.torso.rotation.y = 0;
      u.torso.rotation.z = Math.sin(w) * 0.03;
      u.armL.rotation.x = Math.sin(w) * 0.04;
      u.armR.rotation.x = -Math.sin(w) * 0.04;
      u.armL.rotation.z = 0; u.armR.rotation.z = 0;
      u.foreL.rotation.x = 0; u.foreR.rotation.x = 0;
      u.legL.rotation.x = 0; u.legR.rotation.x = 0;
      u.shinL.rotation.x = 0; u.shinR.rotation.x = 0;
      u.head.rotation.y = Math.sin(t * 0.3 + u.idleLook) * 0.4;
      fig.position.y = u.baseY;
    }
  }

  function _patrolStep(e, dt){
    const u = e.userData;
    const p = u.patrol; if(!p) return;
    const per = p.period || 8;
    u.patrolT = (u.patrolT + dt) % per;
    const phase = u.patrolT / per;
    const goingForward = phase < 0.5;
    const k = goingForward ? (phase * 2) : ((1 - phase) * 2);
    e.position.x = p.ax + (p.bx - p.ax) * k;
    e.position.z = p.az + (p.bz - p.az) * k;
    const dx = goingForward ? (p.bx - p.ax) : (p.ax - p.bx);
    const dz = goingForward ? (p.bz - p.az) : (p.az - p.bz);
    e.rotation.y = Math.atan2(dx, dz);
    u.anim = 'walk';
  }

  // -----------------------------------------------------------------
  // État module + API
  // -----------------------------------------------------------------
  const state_ = {
    ready: false,
    figures: [],          // Object3D racines de chaque figure
    _camPos: new THREE.Vector3(),
    _t: 0,
    _sweepT: 0,
    _budgetMs: 0,
    _spawnCount: 0,
  };

  function init(){
    if(state_.ready) return;
    state_.ready = true;
    console.info('[M-Peuple] prêt · système procédural ·',
      'classes:', Object.keys(CLASS_DEFS).join(','));
  }

  /**
   * Spawn une figure stylisée procédurale.
   * @param {Object} opts
   * @param {string} opts.type   'ouvrier'|'ouvriere'|'chomeur'|'capitaliste'|
   *                             'bourgeois'|'mineur'|'fonctionnaire'
   * @param {string} opts.anim   'idle'|'walk'|'work'|'angry'
   * @param {Object} opts.patrol {ax,az,bx,bz,period}  patrouille A↔B (force anim=walk)
   * @param {number} opts.tint   surcharge la couleur de vêtement (firms, variantes)
   */
  function spawnFigure(opts){
    opts = opts || {};
    if(!state_.ready || state_.figures.length >= MAX_FIGURES){
      const g = new THREE.Group(); g.visible = false; return g;
    }
    const root = buildFigure(opts.type || 'ouvrier', opts);
    if(opts.anim) root.userData.anim = opts.anim;
    if(opts.patrol){
      root.userData.patrol = opts.patrol;
      root.userData.patrolT = Math.random() * (opts.patrol.period || 8);
      root.userData.anim = 'walk';
      _patrolStep(root, 0);
    }
    state_.figures.push(root);
    state_._spawnCount++;
    return root;
  }

  function update(dt){
    if(!state_.ready) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const cam = (typeof camera !== 'undefined') ? camera : null;
    if(cam) state_._camPos.copy(cam.position);
    state_._t += dt;
    state_._sweepT += dt;
    const doSweep = state_._sweepT >= SWEEP_EVERY;
    if(doSweep) state_._sweepT = 0;
    const T = state_._t;
    const figs = state_.figures;
    const camx = state_._camPos.x, camz = state_._camPos.z;
    let writeIdx = 0;
    for(let i = 0; i < figs.length; i++){
      const e = figs[i];
      let attached = !!e.parent;
      if(attached && doSweep){
        let p = e.parent;
        while(p){ if(p === scene) break; p = p.parent; }
        if(!p) attached = false;
      }
      if(!attached) continue;
      if(e.userData.patrol) _patrolStep(e, dt);
      const dx = e.position.x - camx;
      const dz = e.position.z - camz;
      const d2 = dx*dx + dz*dz;
      if(d2 > ANIM_DIST_FAR*ANIM_DIST_FAR){
        if(e.visible){ e.visible = false; e.userData._autoHidden = true; }
        figs[writeIdx++] = e; continue;
      } else if(e.userData._autoHidden && !e.visible){
        e.visible = true; e.userData._autoHidden = false;
      }
      if(!e.visible){ figs[writeIdx++] = e; continue; }
      let doAnim;
      if(d2 < ANIM_DIST_NEAR*ANIM_DIST_NEAR){
        doAnim = true;
      } else if(d2 < ANIM_DIST_MED*ANIM_DIST_MED){
        e.userData.lodTick++;
        if(e.userData.lodTick >= 2){ e.userData.lodTick = 0; doAnim = true; }
        else doAnim = false;
      } else {
        e.userData.lodTick++;
        if(e.userData.lodTick >= 4){ e.userData.lodTick = 0; doAnim = true; }
        else doAnim = false;
      }
      if(doAnim) _animate(e, T);
      figs[writeIdx++] = e;
    }
    figs.length = writeIdx;
    if(t0){
      const ms = performance.now() - t0;
      state_._budgetMs = state_._budgetMs * 0.9 + ms * 0.1;
    }
  }

  function debug(){
    return {
      ready: state_.ready,
      live: state_.figures.length,
      spawned: state_._spawnCount,
      budgetMs: +state_._budgetMs.toFixed(2),
    };
  }

  return { init, spawnFigure, buildFigure, update, debug, CLASS_DEFS };
})();
if(typeof window!=='undefined') window.__peuple = Peuple;

/* Bridge global utilisé par tous les anciens callsites. Sûr d'appeler
   avant Peuple.init() — retourne alors un Group vide invisible. */
function spawnFigure(opts){ return Peuple.spawnFigure(opts); }

/* ===================================================================
   M-Peuple — POPULATION COMME TRADUCTION DES RAPPORTS DE PRODUCTION
   La population n'est plus du décor : chaque figure occupe une zone
   logique, accomplit l'activité de sa CLASSE, et son nombre vit avec
   la simulation (employés → ouvriers au travail, chômage → file, capi-
   tal → parvis de la Bourse, enclosure → paysans qui disparaissent
   des Terres communes, colère → attroupement + gendarmes).

   Implémentation : POOL pré-alloué par (zone × rôle) ; on active/
   désactive `visible` selon le compte calculé à partir de l'état.
   Zéro allocation par frame. Throttle ~0.4 s — la population
   bouge avec le temps social, pas avec le framerate.

   LECTURE SEULE de `state`. N'écrit jamais dans la simulation, ne
   touche ni HUD ni caméra ni bâtiments.
   =================================================================== */
const PeuplePop = (function(){
  const THROTTLE = 0.40;        // s — rafraîchissement des effectifs
  let _t = 0, _ready = false;
  /** @type {Map<string,{figs:THREE.Object3D[],spec:object}>} */
  let _slots = null;

  // ---------- helpers lecture simulation (jamais d'écriture) ----------
  const _safeS = ()=> (typeof state !== 'undefined' && state) ? state : null;
  const _employed   = s => Math.max(0, s.travailleurs|0);
  const _popActive  = s => Math.max(0, s.populationActive|0);
  const _chomeursN  = s => Math.max(0, _popActive(s) - _employed(s));
  // La clôture des communs (acte II de la fondation) chasse la moitié des
  // paysans avant même que la ville ne grandisse.
  const _enclosure  = s => Math.min(1, Math.max(0, (s.niveauVille||0)/7, s.enclos ? 0.5 : 0));
  const _capitalAcc = s => Math.max(0, (s.profitCumule||0)) + Math.max(0, s.argent||0);
  const _isProd     = s => !!s.productionActive;
  const _hasBld     = (s,k) => !!(s.buildings && s.buildings[k]>0);
  const _colere     = s => Math.max(0, Math.min(1, s.colere||0));
  const _phaseGate  = ()=> (typeof gamePhase==='undefined') || gamePhase !== 'precapital';

  // ---------- SPÉCIFICATIONS de rôle par zone ----------
  // Chaque spec : { zone, role, type, anim, tint?, max, count(s), place(f,i,n) }
  // - count(s) : effectif visé (entier ≥ 0), borné à max.
  // - place(f,i,n) : positionne UNE figure existante (mutate fig.position
  //   / fig.rotation / fig.userData.patrol). N'alloue rien.
  const SPECS = [
    // — Terres communes : paysans qui diminuent avec l'enclosure —
    //   M-Peuple-détail : type 'paysan' = chapeau paille + faux + sabots.
    { zone:'Terres communes', role:'paysan', type:'paysan', anim:'farm', precap:true,
      max:6,
      count: s => Math.round( Math.max(0, 6 * (1 - _enclosure(s))) ),
      place: (f,i,n)=>{
        const col = i % 3, row = Math.floor(i/3);
        f.position.set(-6 + col*5, 0, -3 + row*4);
        f.rotation.y = Math.PI*0.5 + (i%2 ? 0.30 : -0.30);
      } },

    // — Mines · Champs : mineurs en extraction —
    { zone:'Mines · Champs', role:'mineur', type:'mineur', anim:'work', max:5,
      count: s => _isProd(s)
        ? Math.max(2, Math.min(5, 2 + Math.floor((s.niveauMachine||0)*0.5)))
        : 1,
      place: (f,i,n)=>{
        const col = i % 3, row = Math.floor(i/3);
        f.position.set(-5 + col*3, 0, 2 + row*3);
        f.rotation.y = -0.3 + (i%2 ? 0.6 : -0.6);
      } },

    // — Usine : ouvriers réellement employés, anim work, orientés au bâtiment —
    { zone:'Usine', role:'ouvrier-emploi', type:'ouvrier', anim:'work', max:10, precap:true,
      count: s => _isProd(s) ? Math.min(10, _employed(s)) : 0,
      place: (f,i,n)=>{
        const k = (i/Math.max(1,n) - 0.5);
        const a = k * Math.PI * 0.9;
        const r = 5.5 + (i%2)*1.6;
        f.position.set(Math.sin(a)*r, 0, Math.cos(a)*r*0.55 - 1.8);
        f.rotation.y = a + Math.PI;       // dos au sud, face au bâtiment
      } },

    // — Usine : capitaliste qui surveille (1, présent quand on emploie) —
    { zone:'Usine', role:'capitaliste-surveille', type:'capitaliste', anim:'watch', max:1, precap:true,
      count: s => (_isProd(s) && _employed(s)>0) ? 1 : 0,
      place: (f,i,n)=>{
        f.position.set(-6.5, 0, 4.5);
        f.rotation.y = Math.PI * 0.85;
      } },

    // — Port : dockers en va-et-vient sur le quai (patrol) —
    { zone:'Port · Marché mondial', role:'docker', type:'ouvrier', anim:'walk', max:6,
      count: s => _hasBld(s,'port') ? Math.max(2, Math.min(6, 3 + ((s.cycle||0)%2))) : 0,
      place: (f,i,n)=>{
        const zOff = 5 + (i%2)*1.4;
        const per  = 12 + (i%3)*2;
        if(!f.userData.patrol){
          f.userData.patrol = { ax:-7, az:zOff, bx:7, bz:zOff, period:per };
          f.userData.patrolT = Math.random() * per;
        } else {
          f.userData.patrol.az = zOff;
          f.userData.patrol.bz = zOff;
          f.userData.patrol.period = per;
        }
      } },

    // — Port : désœuvrés au bord de l'eau (chomeur assis) —
    { zone:'Port · Marché mondial', role:'desoeuvre', type:'chomeur', anim:'sit', max:4,
      count: s => _hasBld(s,'port')
        ? Math.min(4, Math.round(_chomeursN(s) * 0.30))
        : 0,
      place: (f,i,n)=>{
        f.position.set(-9 + i*2.3, 0, -7.2);
        f.rotation.y = 0;
        f.userData.patrol = null;
      } },

    // — Marché de vente : 3 marchands DERRIÈRE la rangée sud des étals.
    //   La place a 2 rangées d'étals (z=-1.5 nord, z=+3.5 sud), table
    //   profonde 1.8 (z=±0.9), AUVENT incliné 3×2.0 (z=±1.0) à y=2.10.
    //   Le marchand se tient au-DELÀ de l'auvent côté sud (z=+5.0,
    //   donc 0.5 m derrière le bord sud de l'auvent à z=+4.5), tourné
    //   vers l'allée client (face nord → rotation.y = π). Sol pavé
    //   à y=0.15 : pieds posés DESSUS, pas encastrés dans le soubassement.
    { zone:'Marché de vente', role:'marchand', type:'marchand', anim:'sell', max:3, precap:true,
      count: s => 3,
      place: (f,i,n)=>{
        f.position.set(-5 + i*5, 0.15, 5.0); // dégagé de l'auvent
        f.rotation.y = Math.PI;              // tourné vers l'allée client
        f.userData.patrol = null;
      } },

    // — Marché de vente : clientèle ∝ taux de vente.
    //   Clients dans l'allée centrale entre les deux rangées d'étals
    //   (z ≈ +1, face sud à la rangée sud), pas dans la rue dehors.
    { zone:'Marché de vente', role:'client', type:'bourgeois', anim:'idle', max:5,
      count: s => {
        if(s.d && s.d.declenche) return 0;
        const tv = (s.d && s.d.tauxVente!=null) ? s.d.tauxVente : 0.7;
        return Math.round(5 * Math.max(0, Math.min(1, tv)));
      },
      place: (f,i,n)=>{
        f.position.set(-5 + i*2.6, 0.15, 1.0 + (i%2)*0.8);
        f.rotation.y = 0;                    // regarde la rangée sud (vers +Z)
        f.userData.patrol = null;
      } },

    // — Marché des moyens (HALLE BALTARD) : 2 marchands DERRIÈRE leurs
    //   étals. La halle a 3 stands en ligne (x=-4.5, 0, +4.5, z=-1),
    //   table profonde 1.8, AUVENT 3×2.2 (z=±1.1) à y=2.10. Les
    //   marchandises (sacs, charbon, chariot) sont au SUD des stands → là
    //   que circulent les clients. Marchand au NORD de l'AUVENT (z=-2.8,
    //   donc 0.7 m derrière le bord nord à z=-2.1) : pas dans le poteau
    //   arrière à z=-1.9, pas sous la toile inclinée. Tourné vers le sud
    //   (rotation.y = 0). Sol pavé de la halle à y=0.55 : pieds DESSUS,
    //   plus encastrés dans le soubassement+plinthe en pierre.
    { zone:'Marché des moyens', role:'marchand', type:'marchand', anim:'sell', max:2, precap:true,
      count: s => 2,
      place: (f,i,n)=>{
        f.position.set(-4.5 + i*9, 0.55, -2.8); // dos aux stands 1 (-4.5) et 3 (+4.5)
        f.rotation.y = 0;                       // face au sud, vers l'allée client
        f.userData.patrol = null;
      } },

    // — Marché du travail : file de chômeurs (∝ chômage réel).
    //   Devant le bureau d'embauche (guichet à z≈+0.05, face sud),
    //   2 rangées tournées vers le guichet (face nord = rotation.y = π).
    { zone:'Marché du travail', role:'file-chomeurs', type:'chomeur', anim:'idle', max:14, precap:true,
      count: s => Math.min(14, _chomeursN(s)),
      place: (f,i,n)=>{
        const col = i % 6, row = Math.floor(i/6);
        f.position.set(-5 + col*1.6, 0, 3.0 + row*1.6);
        f.rotation.y = Math.PI + (i%2 ? 0.10 : -0.10);
        f.userData.patrol = null;
      } },

    // — Bourse : capitalistes au parvis (∝ capital) —
    { zone:'Bourse', role:'capitaliste-parvis', type:'capitaliste', anim:'watch', max:5,
      count: s => _hasBld(s,'bourse')
        ? Math.min(5, Math.max(1, 1 + Math.floor(_capitalAcc(s)/700)))
        : 0,
      place: (f,i,n)=>{
        const dx = (n>1 ? (i/(n-1) - 0.5) : 0) * 11;
        f.position.set(dx, 0, 9.0);
        f.rotation.y = Math.PI + (i%2 ? 0.12 : -0.12);
        f.userData.patrol = null;
      } },

    // — Bourse : bourgeois en flânerie (∝ capital, plus discret) —
    { zone:'Bourse', role:'bourgeois-parvis', type:'bourgeois', anim:'stroll', max:4,
      count: s => _hasBld(s,'bourse')
        ? Math.min(4, Math.max(0, Math.floor(_capitalAcc(s)/1100)))
        : 0,
      place: (f,i,n)=>{
        const per = 24 + i*3;
        if(!f.userData.patrol){
          f.userData.patrol = { ax:-6, az:7.4 + (i%2)*0.8, bx:6, bz:8.4 - (i%2)*0.8, period:per };
          f.userData.patrolT = Math.random() * per;
        }
      } },

    // — Banque : bourgeois sur le perron (∝ argent) —
    { zone:'Banque', role:'bourgeois-banque', type:'bourgeois', anim:'stroll', max:3,
      count: s => Math.min(3, Math.max(0, Math.floor((s.argent||0) / 600))),
      place: (f,i,n)=>{
        const per = 26 + i*3;
        if(!f.userData.patrol){
          f.userData.patrol = { ax:-5, az:7.0 + (i%2)*0.6, bx:5, bz:8.0 - (i%2)*0.6, period:per };
          f.userData.patrolT = Math.random() * per;
        }
      } },

    // — Quartier ouvrier : densité ∝ emploi + niveau quartier (extensible) —
    { zone:'Quartier ouvrier', role:'ouvriere-rue', type:'ouvriere', anim:'idle', max:6,
      count: s => _hasBld(s,'quartier')
        ? Math.min(6, Math.max(2, Math.round(_employed(s)*0.35 + (s.buildings.quartier||0))))
        : 0,
      place: (f,i,n)=>{
        const col = i % 3, row = Math.floor(i/3);
        f.position.set(-6 + col*3.5, 0, -4 + row*1.6);
        f.rotation.y = (col%2) ? Math.PI*0.40 : -Math.PI*0.40;
        f.userData.patrol = null;
      } },

    // — Quartier ouvrier : 2 passants en patrouille (vie sociale visible) —
    { zone:'Quartier ouvrier', role:'ouvrier-passant', type:'ouvrier', anim:'walk', max:2,
      count: s => (_hasBld(s,'quartier') && _employed(s) > 0) ? 2 : 0,
      place: (f,i,n)=>{
        if(!f.userData.patrol){
          f.userData.patrol = (i===0)
            ? { ax:-9, az:5,  bx:9, bz:5.4, period:18 }
            : { ax: 8, az:7,  bx:-8, bz:7.4, period:22 };
          f.userData.patrolT = Math.random() * f.userData.patrol.period;
        }
      } },

    // — Usine : attroupement de grève (anim angry, au-dessus du seuil colère) —
    { zone:'Usine', role:'attroup', type:'ouvrier', anim:'angry', max:7,
      count: s => _colere(s) > 0.40
        ? Math.min(7, 3 + Math.floor((_colere(s) - 0.40) * 10))
        : 0,
      place: (f,i,n)=>{
        const a = (n>1 ? (i/(n-1) - 0.5) : 0) * Math.PI * 0.7;
        f.position.set(Math.sin(a)*7, 0, 11 + Math.cos(a)*1.8);
        f.rotation.y = Math.PI;
        f.userData.patrol = null;
      } },

    // — Usine : gendarmes (apparaissent quand l'attroupement déborde) —
    { zone:'Usine', role:'gendarmes', type:'fonctionnaire', anim:'angry', max:4,
      count: s => _colere(s) > 0.55
        ? Math.min(4, 1 + Math.floor((_colere(s) - 0.55) * 6))
        : 0,
      place: (f,i,n)=>{
        f.position.set(-3 + i*2.0, 0, 13.6);
        f.rotation.y = 0;                         // face nord, vers les ouvriers
        f.userData.patrol = null;
      } },
  ];

  function _slot(spec){
    const k = spec.zone + '|' + spec.role;
    let s = _slots.get(k);
    if(!s){ s = { figs:[], spec }; _slots.set(k, s); }
    return s;
  }

  function _grow(slot, n){
    const zg = (typeof zoneGroups !== 'undefined') ? zoneGroups[slot.spec.zone] : null;
    if(!zg) return false;
    while(slot.figs.length < n && slot.figs.length < slot.spec.max){
      const f = Peuple.spawnFigure({
        type: slot.spec.type,
        anim: slot.spec.anim,
        tint: slot.spec.tint,
      });
      f.visible = false;
      f.userData._popRole = slot.spec.role;
      f.userData._popZone = slot.spec.zone;
      zg.add(f);
      slot.figs.push(f);
    }
    return true;
  }

  function _refresh(slot, n){
    n = Math.max(0, Math.min(n|0, slot.spec.max));
    if(!_grow(slot, n)) return;
    const pool = slot.figs, spec = slot.spec;
    for(let i = 0; i < pool.length; i++){
      const f = pool[i];
      if(i < n){
        if(!f.visible) f.visible = true;
        if(spec.place) spec.place(f, i, n);
        // M-Peuple-détail-b : la pos Y posée par place() devient le baseY
        // de référence des animations procédurales. Sans cela, _animate
        // ré-écrit `fig.position.y = u.baseY` (=0) à chaque frame, alors
        // que _refresh ré-écrit le y posé toutes les 0.4 s → sautillement
        // de la figure entre y posé (pavé) et y=0 (sol). Bug visible au
        // marché de vente (sol pavé y=0.15) et à la halle (y=0.55).
        f.userData.baseY = f.position.y;
        if(spec.anim && f.userData.anim !== spec.anim){
          // les patrouilles imposent 'walk' ; ne pas casser leur cadence.
          if(!f.userData.patrol) f.userData.anim = spec.anim;
        }
      } else if(f.visible){
        f.visible = false;
      }
    }
  }

  function update(dt){
    if(!_ready) return;
    _t += dt;
    if(_t < THROTTLE) return;
    _t = 0;
    const s = _safeS();
    if(!s) return;
    // Fondation : seuls les rôles marqués precap vivent — les paysans des
    // communs (que la clôture chasse), les marchands, la file de la place
    // d'embauche, puis l'ouvrier et le capitaliste à l'atelier. Le reste de
    // la ville attend la naissance du capital.
    const precap = !_phaseGate();
    for(const spec of SPECS){
      if(typeof zoneGroups === 'undefined' || !zoneGroups[spec.zone]) continue;
      _refresh(_slot(spec), (precap && !spec.precap) ? 0 : spec.count(s));
    }
  }

  function init(){
    if(_ready) return;
    _slots = new Map();
    _ready = true;
    _t = THROTTLE + 1;
    update(0);
    console.info('[M-Peuple/Pop] prêt ·', SPECS.length, 'rôles · pool pré-alloué, ZÉRO alloc/frame');
  }

  function debug(){
    const out = {};
    if(!_slots) return out;
    for(const [k, s] of _slots){
      out[k] = {
        live: s.figs.reduce((a,f)=>a + (f.visible?1:0), 0),
        pool: s.figs.length,
        max:  s.spec.max,
      };
    }
    return out;
  }

  return { init, update, debug, SPECS };
})();
if(typeof window!=='undefined') window.__peuplePop = PeuplePop;



/* --- nettoyage des effets cinématiques pour éviter tout coût résiduel après l'intro --- */
function clearTransientCinematicEffects(){
  try{
    if(Array.isArray(fxList)){
      for(const f of fxList){ if(f && f.obj && f.obj.parent) f.obj.parent.remove(f.obj); }
      fxList.length=0;
    }
  }catch(e){}
  try{
    if(Array.isArray(lwTweens)){
      for(const w of lwTweens){ if(w && w.obj) w.obj.scale.set(1,1,1); }
      lwTweens.length=0;
    }
  }catch(e){}
  try{
    if(Array.isArray(floaters)){
      for(const f of floaters){ if(f && f.el && f.el.remove) f.el.remove(); }
      floaters.length=0;
    }
  }catch(e){}
  try{
    if(_floatLayer && _floatLayer.remove){ _floatLayer.remove(); _floatLayer=null; }
  }catch(e){}
}
function shouldRunHeavySceneEffects(){
  if(typeof CycleCinematic!=='undefined' && CycleCinematic.active) return true;
  if(typeof gamePhase!=='undefined' && gamePhase==='precapital') return false;
  if(typeof state==='undefined' || !state) return false;
  return !!(state.productionActive || state.enGreve || (state.d && state.d.risqueCrise>0.03) || (state.niveauVille||0)>0);
}

/* ===================================================================
   FORMATION SOCIALE — le gameplay devient une simulation émergente.
   Couche additive : après le 1er cycle guidé, le circuit cesse d'être
   une route et devient un diagnostic ; les lieux deviennent des postes
   d'intervention ; chaque période donne 3 actions ; le monde produit
   des âges, un classement, un régime et sa propre histoire.
   « Le joueur ne suit plus le circuit : il fait émerger le monde social. »
   =================================================================== */
let gameMode='guided';            // 'guided' (tutoriel) → 'socialFormation'
let pendingEnterSF=false;

// --- rythme : l'atelier jeune coûte cher et accumule lentement ; tout se tend
//     puis se desserre à mesure que la formation mûrit (laisse le temps au joueur) ---
function earlyFactor(){ if((state.age||0)>=2) return 0; return clamp((9-(state.cycle||0))/9); }
function costMul(){ return 1 + 0.5*earlyFactor(); }   // ~1.5 au début → 1.0 ensuite
function fraisPeriode(){ return Math.min(Math.round(22*earlyFactor()), Math.round((state.argent||0)*0.08)); }

const AGES=['Argent dormant','Atelier','Manufacture','Grande industrie','Ville industrielle','Capital financier','Marché mondial'];
const RANKS=['Argent inerte','Petit producteur marchand','Capitaliste d’atelier','Manufacturier','Industriel','Magnat industriel','Puissance financière','Capital monopoliste','Formation sociale avancée'];
const AGE_UNLOCKS={2:['Division du travail','Ouvriers plus nombreux','Revendications collectives'],
  3:['Machines lourdes · rails','Chômage structurel','Surproduction · crises plus violentes'],
  4:['Rails et wagons en circulation','Quartier ouvrier dense','Marché élargi et plus actif'],
  5:['Bourse active · émettre des actions','Dividendes à servir chaque période','Crises financières plus violentes'],
  6:['Port · marché mondial','Exporter · importer bon marché','Crise à l’échelle globale']};
const REGIME_LABEL={liberal:'Libéral instable',socialDemocrate:'Compromis social-démocrate',
  autoritaire:'Autoritaire',revolutionnaire:'Poussée révolutionnaire',communisteFragile:'Commune fragile'};

const historyLog=[];
function addHistoricalEvent(type,text){
  historyLog.unshift({an:state.annee||1,type:type||'neutre',text});
  if(historyLog.length>40) historyLog.pop(); renderHistLog();
}
function renderHistLog(){
  const el=document.getElementById('f-hist'); if(!el) return;
  if(!historyLog.length){ el.innerHTML='<div class="he"><b>Journal</b> — Aucun événement historique stabilisé pour cette formation.</div>'; return; }
  el.innerHTML=historyLog.slice(0,8).map(e=>{
    const txt=String(e.text||'');
    const prefix=/^(An |Cycle |La Commune)/.test(txt)?'':`<b>An ${e.an}</b> — `;
    return `<div class="he">${prefix}${txt}</div>`;
  }).join('');
}

function capitalProductif(s){ return Math.round(s.niveauMachine*150 + s.travailleurs*45
  + (s.buildings.atelier||0)*120 + (s.buildings.usine||0)*220 + (s.buildings.entrepot||0)*90); }
function marketStability(s){ const part=(s.d&&s.d.partJoueur!=null)?s.d.partJoueur:0.33, risk=(s.d&&s.d.risqueCrise)||0;
  return clamp(0.35 + part*0.9 - risk*0.6 - Math.min(0.3,s.stocks/400)); }

// v20 — les âges deviennent de vrais seuils historiques : on ne passe pas à la Manufacture
// par simple clic ou par injection de capital ; il faut durée, stabilité et contradiction traversée.
function ageRequirements(s){
  const a=s.age||1, cap=capitalProductif(s), stab=marketStability(s);
  const req=(label,done,value,score)=>({label,done:!!done,value:value==null?'':String(value),score:score==null?(done?1:0):clamp(score)});
  if(a<=1) return [
    req('10 périodes de développement', s.cycle>=10, `${s.cycle}/10`, Math.min(1,s.cycle/10)),
    req('6 périodes profitables', s.cyclesProfitables>=6, `${s.cyclesProfitables}/6`, Math.min(1,s.cyclesProfitables/6)),
    req('8 ouvriers employés', s.travailleurs>=8, `${s.travailleurs}/8`, Math.min(1,s.travailleurs/8)),
    req('Capital productif ≥ 650 £', cap>=650, money(cap), Math.min(1,cap/650)),
    req('Dette sous contrôle (< 300 £)', s.dette<300, money(s.dette), clamp(1-s.dette/300)),
    req('Stocks non critiques (< 80)', s.stocks<80, Math.round(s.stocks), clamp(1-s.stocks/80)),
    req('Débouchés stables', stab>0.55, Math.round(stab*100)+' %', clamp(stab/0.55)),
    req('Pression traversée', !!s._pressureExperienced, s._pressureExperienced?'oui':'non', s._pressureExperienced?1:0)
  ];
  if(a===2) return [
    req('Machine niveau 3', s.niveauMachine>=3, `${s.niveauMachine}/3`, Math.min(1,s.niveauMachine/3)),
    req('10 ouvriers', s.travailleurs>=10, `${s.travailleurs}/10`, Math.min(1,s.travailleurs/10)),
    req('Capital productif ≥ 1100 £', cap>=1100, money(cap), Math.min(1,cap/1100)),
    req('10 périodes profitables', s.cyclesProfitables>=10, `${s.cyclesProfitables}/10`, Math.min(1,s.cyclesProfitables/10)),
    req('Entrepôt niveau 2', (s.buildings.entrepot||0)>=2, `${s.buildings.entrepot||0}/2`, Math.min(1,(s.buildings.entrepot||0)/2)),
    req('Débouchés tenables', stab>0.4, Math.round(stab*100)+' %', clamp(stab/0.4))
  ];
  if(a===3) return [
    req('Rails construits', (s.buildings.rails||0)>=1, `${s.buildings.rails||0}/1`, Math.min(1,(s.buildings.rails||0)/1)),
    req('14 ouvriers', s.travailleurs>=14, `${s.travailleurs}/14`, Math.min(1,s.travailleurs/14)),
    req('Capital productif ≥ 1800 £', cap>=1800, money(cap), Math.min(1,cap/1800)),
    req('Marché niveau 2', (s.buildings.marche||0)>=2, `${s.buildings.marche||0}/2`, Math.min(1,(s.buildings.marche||0)/2)),
    req('Entrepôt niveau 2', (s.buildings.entrepot||0)>=2, `${s.buildings.entrepot||0}/2`, Math.min(1,(s.buildings.entrepot||0)/2)),
    req('Débouchés tenables', stab>0.4, Math.round(stab*100)+' %', clamp(stab/0.4))
  ];
  if(a===4) return [
    req('Bourse fondée', (s.buildings.bourse||0)>=1, `${s.buildings.bourse||0}/1`, Math.min(1,(s.buildings.bourse||0)/1)),
    req('Capital productif ≥ 2600 £', cap>=2600, money(cap), Math.min(1,cap/2600)),
    req('Débouchés élargis', (s.demandeBonus||0)>=2, `${s.demandeBonus||0}/2`, Math.min(1,(s.demandeBonus||0)/2)),
    req('14 périodes profitables', s.cyclesProfitables>=14, `${s.cyclesProfitables}/14`, Math.min(1,s.cyclesProfitables/14)),
    req('Débouchés tenables', stab>0.4, Math.round(stab*100)+' %', clamp(stab/0.4))
  ];
  if(a===5) return [
    req('Port ouvert', (s.buildings.port||0)>=1, `${s.buildings.port||0}/1`, Math.min(1,(s.buildings.port||0)/1)),
    req('Capital productif ≥ 3500 £', cap>=3500, money(cap), Math.min(1,cap/3500)),
    req('Débouchés mondiaux', (s.demandeBonus||0)>=4, `${s.demandeBonus||0}/4`, Math.min(1,(s.demandeBonus||0)/4)),
    req('Débouchés tenables', stab>0.4, Math.round(stab*100)+' %', clamp(stab/0.4))
  ];
  return [];
}
function ageRequirementProgress(s){ const r=ageRequirements(s); return r.length?clamp(r.reduce((a,b)=>a+(b.score||0),0)/r.length):1; }
function ageRequirementReady(s){ const r=ageRequirements(s); return r.length && r.every(x=>x.done); }
function canReachManufacture(s){ return (s.age||1)<=1 && ageRequirementReady(s); }
function canReachGrandeIndustrie(s){ return s.age===2 && ageRequirementReady(s); }
function canReachVilleIndustrielle(s){ return s.age===3 && ageRequirementReady(s); }
function canReachCapitalFinancier(s){ return s.age===4 && ageRequirementReady(s); }
function canReachMarcheMondial(s){ return s.age===5 && ageRequirementReady(s); }
function ageProgress(s){
  const pr=ageRequirementProgress(s);
  if((s.age||1)<=5) return ageRequirementReady(s)?1:Math.min(pr,0.95);
  return Math.min(1,s.niveauVille/7);
}
function nextAgeName(s){ return AGES[Math.min(AGES.length-1,(s.age||1)+1)]; }

function computeRanking(s){
  const productivePower=clamp(s.niveauMachine*0.12 + s.travailleurs*0.03 + capitalProductif(s)/2500);
  const financialPower=clamp(0.5 + s.argent/1500 - s.dette/600);
  const marketPower=clamp(((s.d&&s.d.partJoueur)||0.3)*1.6);
  const socialControl=clamp(1 - s.colere*0.8 + (s.reproSocial||0)*0.05 - (s.conscience||0)*0.3);
  const politicalStability=clamp((s.regime?s.regime.legitimacy:0.5) - ((s.d&&s.d.declenche)?0.3:0));
  const crisisRisk=clamp((s.d&&s.d.risqueCrise)||0);
  const revolutionaryPotential=clamp(s.colere*0.5 + s.conscience*0.6 + crisisRisk*0.4 - (s.regime?s.regime.repression:0)*0.3 - politicalStability*0.2);
  const power=(productivePower+financialPower+marketPower)/3;
  let lvl=0;
  if((s.age||0)<1) lvl=s.cyclesProfitables>0?1:0;
  if((s.age||0)>=1) lvl=2; if((s.age||0)>=2) lvl=3; if((s.age||0)>=3) lvl=4;
  if((s.age||0)>=3 && power>0.6) lvl=5;
  if((s.buildings.bourse||0)>0 && power>0.6) lvl=6;
  if(marketPower>0.8 && financialPower>0.7) lvl=7;
  if(s.regime && s.regime.communistPossibility>0.6) lvl=8;
  s.ranking={rankName:RANKS[lvl],rankLevel:lvl,productivePower,financialPower,marketPower,socialControl,politicalStability,crisisRisk,revolutionaryPotential};
  return s.ranking;
}
function initRegime(s){ s.regime={type:'liberal',legitimacy:0.5,repression:0.1,socialRights:0,welfare:0,
  statePower:0.2,capitalPower:0.6,workerPower:0.1,revolutionaryPotential:0,authoritarianDrift:0,socialDemocraticDrift:0,communistPossibility:0}; }
function updateRegime(s){ const r=s.regime; if(!r) return;
  r.workerPower=clamp(s.conscience*0.7 + (s.organisation||0)*0.3 + s.colere*0.2);
  r.capitalPower=clamp(0.5 + capitalProductif(s)/2500 - s.colere*0.2);
  const crise=(s.d&&s.d.declenche)?1:0, risk=(s.d&&s.d.risqueCrise)||0;
  if(r.socialRights>0.3 && r.legitimacy>0.5 && s.colere<0.4) r.socialDemocraticDrift=clamp(r.socialDemocraticDrift+0.06);
  if(r.repression>0.4 && s.colere>0.45) r.authoritarianDrift=clamp(r.authoritarianDrift+0.07);
  if((crise||risk>0.6) && r.workerPower>0.5 && r.legitimacy<0.4) r.revolutionaryPotential=clamp(r.revolutionaryPotential+0.08);
  else r.revolutionaryPotential=clamp(r.revolutionaryPotential-0.02);
  r.legitimacy=clamp(r.legitimacy - risk*0.05 - s.colere*0.03 + r.socialRights*0.02 + r.welfare*0.02 + 0.01);
  r.communistPossibility=clamp((r.revolutionaryPotential>0.6 && r.workerPower>0.6 && r.legitimacy<0.35)? r.communistPossibility+0.05 : r.communistPossibility-0.03);
  let type='liberal';
  if(r.revolutionaryPotential>0.6) type='revolutionnaire';
  else if(r.authoritarianDrift>0.45) type='autoritaire';
  else if(r.socialDemocraticDrift>0.45) type='socialDemocrate';
  if(r.communistPossibility>0.6) type='communisteFragile';
  r.type=type;
}

/* ===================================================================
   AGENTS SOCIAUX — des forces autonomes, pas de simples variables.
   Chaque groupe a une force, une satisfaction, une organisation et une
   mémoire ; il évolue selon les conditions et les choix, et rétroagit
   sur le régime, le classement et les bifurcations.
   =================================================================== */
function initGroups(s){ s.groups={
  capitalists:{force:0.6,satisfaction:0.6,organisation:0.5,memory:[]},
  workers:{nombre:s.travailleurs,force:0.2,satisfaction:0.5,colere:s.colere,conscience:s.conscience,organisation:0.08,rancune:0,confiance:0,memory:[]},
  unemployed:{nombre:0,force:0.05,satisfaction:0.35,memory:[]},
  bankers:{force:0.3,satisfaction:0.6,pression:0.1,mefiance:0,memory:[]},
  state:{force:0.2,legitimacy:0.5,repression:0.1,memory:[]},
  merchants:{force:0.3,satisfaction:0.5,memory:[]},
  unions:{force:0.04,organisation:0.04,reconnaissance:0,memory:[]},
  revolutionaries:{force:0.0,potential:0.0,memory:[]},
}; s._grpFlags={}; s._memFlags={}; }
/* mémoire des agents : ils n'oublient pas les choix passés */
function rememberEvent(s,groupKey,kind,label){
  const g=s.groups&&s.groups[groupKey]; if(!g) return;
  g.memory=g.memory||[]; g.memory.unshift({kind,label:label||kind,an:s.annee||1}); if(g.memory.length>6) g.memory.pop();
  if(groupKey==='workers'){
    if(kind==='repression'){ g.rancune=clamp((g.rancune||0)+0.22); g.confiance=clamp((g.confiance||0)-0.10); }
    else if(kind==='concession'){ g.confiance=clamp((g.confiance||0)+0.16); g.rancune=clamp((g.rancune||0)-0.06); }
    else if(kind==='trahison'){ g.rancune=clamp((g.rancune||0)+0.20); g.confiance=clamp((g.confiance||0)-0.18); }
  } else if(groupKey==='bankers'){
    if(kind==='defaut') g.mefiance=clamp((g.mefiance||0)+0.20);
    else if(kind==='remboursement') g.mefiance=clamp((g.mefiance||0)-0.10);
  }
}
/* apaiser les ouvriers — l'effet dépend de la mémoire (rancune émousse, confiance amplifie) */
function apaiserOuvriers(amount,label){
  const w=state.groups&&state.groups.workers; const ranc=w?(w.rancune||0):0, conf=w?(w.confiance||0):0;
  const eff=amount*(1 - ranc*0.55 + conf*0.25);
  state.colere=clamp(state.colere - Math.max(0.015,eff));
  rememberEvent(state,'workers','concession',label||'concession');
}
function updateSocialGroups(s){
  if(!s.groups) initGroups(s);
  const g=s.groups, r=s.regime||{}, d=s.d||{};
  const risk=d.risqueCrise||0, crise=d.declenche?1:0;
  const unemployedN=Math.max(0,Math.round((s.populationActive||0)-s.travailleurs));
  // patrons
  g.capitalists.force=clamp(0.4 + capitalProductif(s)/2500 + s.argent/2500);
  g.capitalists.satisfaction=clamp(0.5 + ((d.resultatNet||0)>0?0.2:-0.2) - s.dette/900);
  // ouvriers — l'organisation s'accumule (conscience, grève, colère) et se tasse lentement
  g.workers.nombre=s.travailleurs; g.workers.colere=s.colere; g.workers.conscience=s.conscience;
  const ranc=g.workers.rancune||0, conf=g.workers.confiance||0;
  g.workers.organisation=clamp(g.workers.organisation*(0.9+ranc*0.06) + s.conscience*0.12 + (s.enGreve?0.08:0) + (s.colere>0.5?0.05:0) + (r.repression>0.5?0.04:0));
  g.workers.force=clamp(s.travailleurs/22 + g.workers.organisation*0.6 + s.colere*0.2 + ranc*0.1);
  g.workers.satisfaction=clamp(0.7 - s.colere*0.8 + (s.salaire-5)*0.04 + (s.reproSocial||0)*0.04 - ranc*0.2 + conf*0.15 - (s.niveauMachine||0)*0.012);
  // armée industrielle de réserve — grossit avec la mécanisation et la grande industrie
  g.unemployed.nombre=unemployedN;
  g.unemployed.force=clamp(s.chomage*0.6 + (s.niveauMachine>=3?0.12:0) + ((s.age||0)>=3?0.1:0));
  g.unemployed.satisfaction=clamp(0.45 - s.chomage*0.5);
  // banquiers — pression selon dette / faible légitimité
  g.bankers.pression=clamp(s.dette/600 + (1-(r.legitimacy||0.5))*0.3);
  g.bankers.force=clamp(0.3 + s.dette/700);
  g.bankers.satisfaction=clamp(0.5 + s.tauxInteret*2 - (d.faillite?0.4:0));
  // État
  g.state.force=clamp((r.statePower||0.2) + (r.repression||0)*0.5 + ((s.age||0)>=3?0.1:0));
  g.state.legitimacy=r.legitimacy||0.5; g.state.repression=r.repression||0;
  // marchands / concurrence
  const part=(d.partJoueur!=null)?d.partJoueur:0.33;
  g.merchants.force=clamp(1-part); g.merchants.satisfaction=clamp(part*1.2);
  // syndicats — émergent de l'organisation ouvrière + reconnaissance institutionnelle
  g.unions.organisation=clamp(g.workers.organisation*0.85 + (r.socialRights||0)*0.3);
  g.unions.reconnaissance=clamp((r.socialRights||0) + (r.socialDemocraticDrift||0)*0.5);
  g.unions.force=clamp(g.unions.organisation*0.8 + g.unions.reconnaissance*0.3 + ((s.age||0)>=2?0.08:0) + ((s.age||0)>=3?0.07:0));
  // révolutionnaires — crise + conscience + faible légitimité, brisés par la répression
  g.revolutionaries.potential=clamp(g.revolutionaries.potential*0.85 + s.conscience*0.14 + risk*0.14 + crise*0.2
    + (g.unions.force>0.5?0.06:0) - (r.repression||0)*0.10 - (r.legitimacy||0.5)*0.08);
  g.revolutionaries.force=clamp(g.revolutionaries.potential * (g.workers.organisation>0.4?1:0.5));
  // --- rétroactions douces vers le reste du modèle ---
  s.organisation=g.unions.organisation;                              // ferme la boucle vers updateRegime
  if(g.bankers.pression>0.7) s.tauxInteret=Math.min(0.20,s.tauxInteret+0.01);   // pression bancaire
  if(g.unemployed.force>0.5) s.peurChomage=clamp(s.peurChomage+0.03);           // l'armée de réserve discipline
  if(g.revolutionaries.force>0.5 && r.revolutionaryPotential!=null) r.revolutionaryPotential=clamp(r.revolutionaryPotential+0.04);
  // --- mémoire : décroissance lente + effets durables ---
  g.workers.rancune=clamp((g.workers.rancune||0)*0.96);
  g.workers.confiance=clamp((g.workers.confiance||0)*0.95);
  g.bankers.mefiance=clamp((g.bankers.mefiance||0)*0.97);
  if((g.workers.rancune||0)>0.4) s.colere=clamp(s.colere + 0.02*g.workers.rancune);   // la rancune fait remonter la colère
  if((g.workers.confiance||0)>0.4) s.colere=clamp(s.colere - 0.01*g.workers.confiance); // la confiance l'apaise un peu
  if(s.dette>(s.plafondCredit||500)*0.9 || s.argent<0) g.bankers.mefiance=clamp((g.bankers.mefiance||0)+0.05);
  if((g.bankers.mefiance||0)>0.4) s.tauxInteret=Math.min(0.22, s.tauxInteret + 0.01*g.bankers.mefiance); // la méfiance durcit le crédit
  // --- événements ponctuels (apparition d'une force sociale) ---
  const F=s._grpFlags||(s._grpFlags={}), M=s._memFlags||(s._memFlags={});
  if(!F.unions && g.unions.force>0.4){ F.unions=1; addHistoricalEvent('social','Un syndicat se constitue : les ouvriers ne négocient plus un par un.'); }
  if(!F.reserve && g.unemployed.force>0.45){ F.reserve=1; addHistoricalEvent('social','Une armée industrielle de réserve se forme : le chômage pèse sur les salaires.'); }
  if(!F.revo && g.revolutionaries.force>0.45){ F.revo=1; addHistoricalEvent('crise','Des noyaux révolutionnaires apparaissent dans les quartiers ouvriers.'); }
  if(!F.bankpow && g.bankers.pression>0.75){ F.bankpow=1; addHistoricalEvent('crise','La banque impose ses conditions : le capital financier prend le dessus.'); }
  // --- mémoire : seuils franchis ---
  if(!M.rancune && g.workers.rancune>0.5){ M.rancune=1; addHistoricalEvent('social','Les ouvriers n’ont pas oublié la répression : la rancune s’installe et durcit les rapports.'); }
  if(M.rancune && g.workers.rancune<0.25) M.rancune=0;
  if(!M.confiance && g.workers.confiance>0.5){ M.confiance=1; addHistoricalEvent('social','Un climat de confiance s’installe : les concessions passées portent leurs fruits.'); }
  if(M.confiance && g.workers.confiance<0.25) M.confiance=0;
  if(!M.mefiance && g.bankers.mefiance>0.5){ M.mefiance=1; addHistoricalEvent('crise','La banque se méfie : après les défauts, le crédit se fait rare et cher.'); }
  if(M.mefiance && g.bankers.mefiance<0.25) M.mefiance=0;
}
const GROUP_VIEW=[
  ['Patrons','capitalists','force',0x5a4530],
  ['Ouvriers','workers','force',0x4d5f70],
  ['Chômeurs','unemployed','force',0x6c665c],
  ['Banquiers','bankers','force',0xa8812c],
  ['État','state','force',0x4f5a3e],
  ['Syndicats','unions','force',0x3a5a6a],
  ['Révolution','revolutionaries','force',0x8a2c1d],
];
function diagnoseCircuit(s){ const d=s.d||{}; const o={};
  o['A']= s.dette>250 || s.argent<60;
  o['M']= s.niveauMachine<1 || (s.cyclesSansInvestir||0)>=3;
  o['Ft']= s.travailleurs<3 || s.chomage>0.4 || s.colere>0.45 || s.enGreve;
  o['P']= !s.productionActive || s.fatigue>0.6 || d.accident;
  o['M\u2032']= s.stocks>((s.stockCapaciteBonus?120:90) - ((s.age||0)>=3?25:0)) || (d.invendus||0)>((s.age||0)>=3?30:40);
  o['A\u2032']= (d.partJoueur!=null && d.partJoueur<0.22) || (d.demande!=null && d.demande<30) || s.prixUnitaire<1.1;
  return o;
}
function dominantContradiction(s){ const g=diagnoseCircuit(s);
  if(g['Ft'] && (s.colere>0.45||s.enGreve)) return 'Travail · conflit social';
  if(g['M\u2032']) return 'Surproduction · stocks';
  if(g['A']) return 'Dette · capital financier';
  if(g['A\u2032']) return 'Débouchés · concurrence';
  if(g['P']) return 'Production · usure';
  if(g['M']) return 'Capital constant insuffisant';
  return 'Aucune tension dominante';
}

const CIRCUIT_LETTERS={
  'A':{title:'A — Argent avancé', meaning:'Le cycle commence par une somme d’argent qui n’est pas encore du capital. Elle devient capital si elle est avancée pour acheter moyens, travail et revenir augmentée.'},
  'M':{title:'M — Moyens de production', meaning:'M désigne ici les moyens achetés : matières, outils, machines, capital constant. Sans eux, la production reste trop faible.'},
  'Ft':{title:'Ft — Force de travail', meaning:'Ft est la force de travail achetée sur le marché du travail. C’est une marchandise particulière : elle peut produire plus de valeur qu’elle ne coûte en salaire.'},
  'P':{title:'P — Production', meaning:'P est le procès de production : ouvriers, machines et matières y transforment les moyens achetés en marchandises porteuses de valeur.'},
  'M′':{title:'M′ — Marchandises produites', meaning:'M′ désigne les marchandises sorties de la production. Elles contiennent une valeur accrue, mais cette valeur reste virtuelle tant qu’elles ne sont pas vendues.'},
  'A′':{title:'A′ — Argent revenu augmenté', meaning:'A′ est l’argent revenu après la vente. Le cycle a réussi seulement si A′ dépasse A : la plus-value est alors réalisée.'}
};
function circuitDiagnostic(sym,s){
  const d=s.d||{}, reasons=[], actions=[];
  const pc=v=>Math.round(clamp(v)*100)+' %';
  const m=v=>money(Math.round(v));
  if(sym==='A'){
    if(s.argent<60) reasons.push(`liquidité basse : ${m(s.argent)} disponibles`);
    if(s.dette>250) reasons.push(`dette lourde : ${m(s.dette)} à porter`);
    actions.push('Va à la Banque : emprunte si la trésorerie bloque, rembourse ou renégocie si les intérêts mangent le profit.');
    actions.push('Évite les investissements lourds avant d’avoir stabilisé un cycle profitable.');
  } else if(sym==='M'){
    if(s.niveauMachine<1) reasons.push('capital constant insuffisant : machines/outils trop faibles');
    if((s.cyclesSansInvestir||0)>=3) reasons.push('pas assez de réinvestissement récent dans les moyens de production');
    actions.push('Va au Marché des moyens pour acheter une machine comptant, ou à l’Usine pour installer une machine à crédit.');
    actions.push('Réinvestis une partie du profit si la productivité plafonne.');
  } else if(sym==='Ft'){
    if(s.travailleurs<3) reasons.push(`main-d’œuvre insuffisante : ${s.travailleurs} ouvrier(s)`);
    if(s.chomage>0.4) reasons.push(`chômage élevé : ${pc(s.chomage)} de réserve ouvrière`);
    if(s.colere>0.45) reasons.push(`colère ouvrière élevée : ${pc(s.colere)}`);
    if(s.enGreve) reasons.push('grève en cours : la production peut se bloquer');
    actions.push('Va au Marché du travail : embauche si la production manque de bras, augmente les salaires si la colère bloque le cycle.');
    actions.push('Va au Quartier ouvrier ou à l’État si le conflit devient politique.');
  } else if(sym==='P'){
    if(!s.productionActive) reasons.push('production inactive ou trop faible');
    if(s.fatigue>0.6) reasons.push(`fatigue élevée : ${pc(s.fatigue)}`);
    if(d.accident) reasons.push('accident de production signalé ce cycle');
    actions.push('Va à l’Usine : règle journée, salaire, sécurité et machines.');
    actions.push('Réduis la journée ou améliore la sécurité si la fatigue ou les accidents dominent.');
  } else if(sym==='M′'){
    const cap=(s.stockCapaciteBonus?120:90) - ((s.age||0)>=3?25:0);
    if(s.stocks>cap) reasons.push(`stocks totaux trop hauts : ${Math.round(s.stocks)} / seuil ${cap}`);
    if((d.invendus||0)>((s.age||0)>=3?30:40)) reasons.push(`invendus du cycle : ${Math.round(d.invendus||0)}`);
    actions.push('Va à l’Entrepôt : liquide les stocks ou agrandis la capacité de stockage.');
    actions.push('Réduis la production ou améliore les débouchés si les invendus reviennent souvent.');
  } else if(sym==='A′'){
    if(d.partJoueur!=null && d.partJoueur<0.22) reasons.push(`part de marché faible : ${pc(d.partJoueur)}`);
    if(d.demande!=null && d.demande<30) reasons.push(`demande solvable basse : ${Math.round(d.demande)}`);
    if(s.prixUnitaire<1.1) reasons.push(`prix très bas : ${money2(s.prixUnitaire)} par unité`);
    actions.push('Va au Marché de vente : baisse le prix pour vendre plus, ou élargis les débouchés si la demande manque.');
    actions.push('Surveille la concurrence : produire ne suffit pas, il faut réaliser la valeur par la vente.');
  }
  if(!reasons.length){
    reasons.push('pas de tension majeure détectée sur ce point du circuit');
  }
  return {alert:!!diagnoseCircuit(s)[sym], reasons, actions, meta:CIRCUIT_LETTERS[sym]||{title:sym,meaning:'—'}};
}
function openCircuitInfo(sym){
  const info=circuitDiagnostic(sym,state), meta=info.meta;
  const box=document.getElementById('circuit-info'); if(!box) return;
  set('ci-title',meta.title);
  const st=document.getElementById('ci-status');
  if(st){ st.className='distatus '+(info.alert?'alert':'ok'); st.textContent=info.alert?'⚠ Point du circuit en tension':'✓ Aucun blocage majeur ici'; }
  const meaning=document.getElementById('ci-meaning'); if(meaning) meaning.innerHTML=meta.meaning;
  const reasons=document.getElementById('ci-reasons'); if(reasons) reasons.innerHTML=info.reasons.map(r=>`<li>${r}</li>`).join('');
  const actions=document.getElementById('ci-actions'); if(actions) actions.innerHTML=info.actions.map(a=>`<li>${a}</li>`).join('');
  box.classList.add('on'); refreshModalMode();
}
function closeCircuitInfo(){ const box=document.getElementById('circuit-info'); if(box) box.classList.remove('on'); refreshModalMode(); }

/* --- lieux = postes d'intervention --- */
function deckPlay(id){ const it=DECK.find(x=>x.id===id)||BANK_DECK.find(x=>x.id===id);
  if(it && (!it.can||it.can())){ it.play(); return true; } return false; }
const ZONE_ACTIONS={
 'Banque':[
   {label:'Emprunter 100 £', sub:'+ trésorerie · + dette + intérêts', can:s=>s.plafondCredit-s.dette>=100, run:()=>emprunter(100)},
   {label:'Rembourser 50 £', sub:'− dette · − intérêts futurs', can:s=>s.dette>0&&s.argent>=50, run:()=>rembourser(50)},
   {label:'Renégocier la dette', sub:'taux d’intérêt abaissé', can:s=>s.dette>100, run:()=>{ state.tauxInteret=Math.max(0.04,state.tauxInteret-0.02); pushLog('Banque','Dette renégociée : le taux baisse — la pression bancaire se desserre.'); }},
 ],
 'Usine':[
   {label:'Installer une machine (crédit)', sub:'+ productivité · + dette 200 £', can:s=>true, run:()=>{ if(!deckPlay('mach')){ state.niveauMachine++; state.dette+=200; state._investedThisCycle=true; pushLog('Usine','Machine installée à crédit.'); } }},
   {label:'Intensifier (journée +1 h)', sub:'+ plus-value · + fatigue/colère', can:s=>s.heures<s.limiteJournee, run:()=>deckPlay('jour')},
   {label:'Réduire la journée', sub:'− fatigue/colère · − production', can:s=>s.heures>8, run:()=>deckPlay('jour_down')},
   {label:'Améliorer la sécurité', sub:'− accidents · − colère · −50 £', can:s=>s.argent>=50, run:()=>{ state.argent-=50; state.securiteNiveau=(state.securiteNiveau||0)+1; state.sante=clamp(state.sante+0.1); apaiserOuvriers(0.08,'sécurité'); if(state.revendication==='securite')state.revendication=null; pushLog(productionPlaceLabel(),'Sécurité améliorée (−50 £).'); }},
   {label:'Construire des rails', sub:'infrastructure · wagons · ~350 £ (grande industrie)', can:s=>(s.age||0)>=3 && s.argent>=350, run:()=>{ state.argent-=350; state.buildings.rails=(state.buildings.rails||0)+1; state.railsBonus=Math.min(0.5,(state.railsBonus||0)+0.16); state._investedThisCycle=true; if(typeof updateBuildings==='function') updateBuildings(); pushLog('Usine','Rails construits : wagons et circulation accélérée des marchandises.'); }},
   {label:'Automatiser une ligne', sub:'machines remplacent des ouvriers · + productivité · + chômage/colère', can:s=>(s.niveauMachine||0)>=4 && s.travailleurs>1 && s.argent>=250, run:()=>{ state.argent-=250; state.niveauMachine++; const lic=Math.min(2,state.travailleurs-1); state.travailleurs-=lic; state.populationActive=Math.max(state.populationActive,state.travailleurs+lic); state.colere=clamp(state.colere+0.06); if(typeof recomputeProduction==='function') recomputeProduction(); pushLog('Usine',`Ligne automatisée : ${lic} ouvrier(s) remplacé(s) par des machines. La productivité monte, l’armée de réserve grossit.`,'warn'); }},
 ],
 'Marché du travail':[
   {label:'Embaucher', sub:'+ travail vivant · + masse salariale', can:s=>true, run:()=>{ state.populationActive=Math.max(state.populationActive,state.travailleurs+1); if(!deckPlay('hire')){ state.travailleurs++; recomputeProduction(); } }},
   {label:'Licencier', sub:'+ chômage · + colère', can:s=>s.travailleurs>1, run:()=>deckPlay('fire')},
   {label:'Augmenter les salaires', sub:'− colère · − profit', can:s=>true, run:()=>deckPlay('sal')},
   {label:'Baisser les salaires', sub:'+ exploitation · + colère', can:s=>s.salaire>3, run:()=>deckPlay('sal_down')},
 ],
 'Entrepôt':[
   {label:'Liquider les stocks', sub:'vendre à perte · trésorerie ↑', can:s=>s.stocks>5, run:()=>{ const v=Math.round(state.stocks*state.prixUnitaire*0.6); state.argent+=v; pushLog('Entrepôt',`Stocks liquidés à perte : +${money(v)}.`,'warn'); state.stocks=0; }},
   {label:'Agrandir l’entrepôt', sub:'+ capacité de stock · ~180 £ (majoré au début)', can:s=>s.argent>=Math.round(180*costMul()), run:()=>{ const c=Math.round(180*costMul()); state.argent-=c; state.buildings.entrepot=(state.buildings.entrepot||0)+1; state.stockCapaciteBonus=(state.stockCapaciteBonus||0)+1; state._investedThisCycle=true; pushLog('Entrepôt',`Entrepôt agrandi (−${c} £).`); }},
 ],
 'Marché de vente':[
   {label:'Baisser les prix', sub:'+ ventes · − marge', can:s=>s.prixUnitaire>0.9, run:()=>{ state.prixUnitaire=Math.max(0.9,+(state.prixUnitaire-0.1).toFixed(2)); pushLog('Marché de vente',`Prix abaissé à ${state.prixUnitaire} £ : on prend le marché aux concurrents.`); }},
   {label:'Augmenter les prix', sub:'+ marge · − ventes', can:s=>true, run:()=>{ state.prixUnitaire=+(state.prixUnitaire+0.1).toFixed(2); pushLog('Marché de vente',`Prix relevé à ${state.prixUnitaire} £.`); }},
   {label:'Élargir le marché', sub:'+ demande solvable · ~220 £ (majoré au début)', can:s=>s.argent>=Math.round(220*costMul()), run:()=>{ const c=Math.round(220*costMul()); state.argent-=c; state.demandeBonus=(state.demandeBonus||0)+1; state.buildings.marche=(state.buildings.marche||0)+1; state._investedThisCycle=true; pushLog('Marché de vente',`Débouchés élargis (−${c} £).`); }},
 ],
 'Quartier ouvrier':[
   {label:'Construire des logements', sub:'− colère durable · ~150 £ (majoré au début)', can:s=>s.argent>=Math.round(150*costMul()), run:()=>{ const c=Math.round(150*costMul()); state.argent-=c; state.buildings.quartier=(state.buildings.quartier||0)+1; state.reproSocial=(state.reproSocial||0)+1; apaiserOuvriers(0.1,'logements'); state._investedThisCycle=true; pushLog('Quartier ouvrier',`Logements ouvriers (−${c} £) : la reproduction sociale s’organise.`); }},
   {label:'Négocier', sub:'concession payante · − colère · droits ↑', can:s=>s.argent>=Math.round(40+s.travailleurs*6), run:()=>{ const c=Math.round(40+state.travailleurs*6); state.argent-=c; apaiserOuvriers(0.12,'négociation'); if(state.regime){ state.regime.socialRights=clamp(state.regime.socialRights+0.08); state.regime.legitimacy=clamp(state.regime.legitimacy+0.04);} pushLog('Quartier ouvrier',`Négociation (−${c} £) : des concessions ont un prix — salaires et conditions concédés.`,'social'); }},
 ],
 'État · Tribunal':[
   {label:'Voter une loi sociale', sub:'droits ↑ · légitimité ↑ · profit ↓', can:s=>true, run:()=>{ state.limiteJournee=Math.max(8,state.limiteJournee-2); if(state.regime){ state.regime.socialRights=clamp(state.regime.socialRights+0.12); state.regime.welfare=clamp(state.regime.welfare+0.08); state.regime.legitimacy=clamp(state.regime.legitimacy+0.05);} state.modeEtat='réforme'; apaiserOuvriers(0.08,'loi sociale'); pushLog('État','Loi sociale : journée plafonnée, droits étendus.','social'); }},
   {label:'Réprimer', sub:'colère ↓ court terme · conscience ↑', can:s=>true, run:()=>{ state.colere=clamp(state.colere-0.12); state.conscience=clamp(state.conscience+0.1); state.modeEtat='répression'; if(state.regime){ state.regime.repression=clamp(state.regime.repression+0.12); state.regime.legitimacy=clamp(state.regime.legitimacy-0.04);} rememberEvent(state,'workers','repression','répression d’État'); pushLog('État','Répression : l’ordre règne — la conscience de classe aussi, et la rancune.','social'); }},
 ],
 'Marché des moyens':[
   {label:'Acheter une machine (comptant)', sub:'+ productivité · ~300 £ (majoré au début)', can:s=>s.argent>=Math.round(300*costMul()), run:()=>{ const c=Math.round(300*costMul()); state.argent-=c; state.niveauMachine++; state._investedThisCycle=true; if(typeof updateCapitalStage==='function') updateCapitalStage(); pushLog('Marché des moyens',`Machine achetée comptant (−${c} £).`); }},
 ],
 'Bourse':[
   {label:'Fonder la Bourse', sub:'capital financier · ~600 £ (dès la Ville industrielle)', can:s=>(s.age||0)>=4 && (s.buildings.bourse||0)<1 && s.argent>=600, run:()=>{ state.argent-=600; state.buildings.bourse=1; state.bourseActive=true; state.creditBonus=(state.creditBonus||0)+150; state.plafondCredit=(state.plafondCredit||500)+400; state._investedThisCycle=true; if(typeof updateZoneVisibility==='function') updateZoneVisibility(); if(typeof updateBuildings==='function') updateBuildings(); pushLog('Bourse','La Bourse est fondée : le capital devient financier — on peut lever du capital en émettant des actions, et le crédit s’élargit.'); }},
   {label:'Émettre des actions', sub:'+ capital immédiat · + dividendes à servir', can:s=>(s.buildings.bourse||0)>=1, run:()=>{ const lev=Math.round(350+(state.niveau||1)*40); state.argent+=lev; state.dividende=(state.dividende||0)+Math.round(lev*0.06); pushLog('Bourse',`Actions émises : +${money(lev)} de capital levé, mais ${money(Math.round(lev*0.06))} de dividendes à servir chaque période.`,'warn'); }},
   {label:'Spéculer', sub:'pari financier · gain ou perte · capital fictif', can:s=>(s.buildings.bourse||0)>=1 && s.argent>=120, run:()=>{ const stab=marketStability(state); const win=Math.random()<(0.40+stab*0.30); const stake=Math.round(120+state.argent*0.05); if(win){ state.argent+=stake; pushLog('Bourse',`Spéculation gagnante : +${money(stake)}. Le capital fictif enfle.`,'good'); } else { state.argent-=stake; pushLog('Bourse',`Spéculation perdante : −${money(stake)}. La bulle se dégonfle.`,'warn'); } }},
 ],
 'Port · Marché mondial':[
   {label:'Ouvrir le port', sub:'marché mondial · ~700 £ (dès le Capital financier)', can:s=>(s.age||0)>=5 && (s.buildings.port||0)<1 && s.argent>=700, run:()=>{ state.argent-=700; state.buildings.port=1; state.portOuvert=true; state.demandeBonus=(state.demandeBonus||0)+4; state._investedThisCycle=true; if(typeof updateZoneVisibility==='function') updateZoneVisibility(); if(typeof updateBuildings==='function') updateBuildings(); pushLog('Port · Marché mondial','Le port s’ouvre : le capital conquiert le marché mondial — des débouchés massifs, mais la crise pourra se propager à l’échelle globale.'); }},
   {label:'Exporter les stocks', sub:'écouler la production sur le marché mondial · + trésorerie', can:s=>(s.buildings.port||0)>=1 && s.stocks>3, run:()=>{ const v=Math.round(state.stocks*state.prixUnitaire*0.85); state.argent+=v; state.stocks=Math.max(0,Math.round(state.stocks*0.2)); pushLog('Port · Marché mondial',`Exportation : stocks écoulés sur le marché mondial (+${money(v)}).`,'good'); }},
   {label:'Importer des matières bon marché', sub:'− coût de production quelques périodes · ~150 £', can:s=>(s.buildings.port||0)>=1 && s.argent>=150, run:()=>{ state.argent-=150; state.importCheap=(state.importCheap||0)+3; pushLog('Port · Marché mondial','Matières premières importées à bas coût : la production coûte moins cher pour quelques périodes.'); }},
 ],
};
// (B) lecture de l'état courant des catégories concernées, à l'ouverture d'un bâtiment
function zoneReadout(name,s){
  const pc=v=>Math.round(v*100)+' %', m=v=>money(Math.round(v));
  switch(name){
    case 'Banque': { const cw=(typeof CompetitorWorld!=='undefined'&&CompetitorWorld.revealed)?CompetitorWorld.firms().filter(c=>c.vivant):[];
      const cred=cw.reduce((a,c)=>a+c.debt,0);
      return `Trésorerie <b>${m(s.argent)}</b> · Dette <b>${m(s.dette)}</b> · Taux <b>${pc(s.tauxInteret)}</b> · Plafond crédit <b>${m(s.plafondCredit||0)}</b>`+
        (cw.length?`<br><i>Mêmes guichets pour tous — crédits ouverts aux concurrents : <b>${m(cred)}</b>${cw.some(c=>c.debt>260)?' (dont un débiteur fragile)':''}</i>`:''); }
    case 'Usine': { const w=s.groups&&s.groups.workers; const rel=w?(w.satisfaction>0.55?'bon':w.satisfaction<0.35?'aliéné':'tendu'):'—'; return `Journée <b>${s.heures} h</b> / max <b>${s.limiteJournee} h</b> · Machines <b>niv. ${s.niveauMachine}</b> · Sécurité <b>niv. ${s.securiteNiveau||0}</b> · Ouvriers <b>${s.travailleurs}</b> · Rapport ouvrier <b>${rel}</b>`; }
    case 'Marché du travail': { const cw=(typeof CompetitorWorld!=='undefined'&&CompetitorWorld.revealed)?CompetitorWorld.firms().filter(c=>c.vivant):[];
      const emp=cw.reduce((a,c)=>a+c.workers,0); const wmin=cw.length?Math.min(...cw.map(c=>c.wage)):0, wmax=cw.length?Math.max(...cw.map(c=>c.wage)):0;
      return `Ouvriers <b>${s.travailleurs}</b> · Salaire <b>${m(s.salaire)}</b> · Chômage <b>${pc(s.chomage)}</b> · Colère <b>${pc(s.colere)}</b>`+
        (cw.length?`<br><i>Le même marché embauche pour tous — concurrents : <b>${emp}</b> ouvriers, salaires <b>${wmin}–${wmax} £</b>${wmax>s.salaire?' (on paie mieux ailleurs)':''}</i>`:''); }
    case 'Entrepôt': return `Stocks <b>${Math.round(s.stocks)}</b> · Capacité <b>${(s.stockCapaciteBonus?'étendue':'standard')}</b> · Prix unitaire <b>${m(s.prixUnitaire)}</b>`;
    case 'Marché de vente': { const part=(s.d&&s.d.partJoueur!=null)?s.d.partJoueur:null;
      const cw=(typeof CompetitorWorld!=='undefined'&&CompetitorWorld.revealed)?CompetitorWorld.firms().filter(c=>c.vivant):[];
      const px=cw.map(c=>`${c.nom.split(' ').pop()} <b>${money2(c.prix)}</b>`).join(' · ');
      return `Prix <b>${m(s.prixUnitaire)}</b> · Part de marché <b>${part!=null?pc(part):'—'}</b> · Débouchés <b>+${s.demandeBonus||0}</b>`+
        (cw.length?`<br><i>Prix affichés sur le même marché — ${px}</i>`:''); }
    case 'Quartier ouvrier': { const w=s.groups&&s.groups.workers; const mem=w?(w.rancune>0.45?'rancune':w.confiance>0.45?'confiance':'neutre'):'—'; return `Colère <b>${pc(s.colere)}</b> · Logements <b>${s.buildings.quartier||0}</b> · Reproduction <b>${s.reproSocial||0}</b> · Mémoire <b>${mem}</b>`; }
    case 'État · Tribunal': { const r=s.regime||{}; return `Journée max <b>${s.limiteJournee} h</b> · Droits <b>${pc(r.socialRights||0)}</b> · Répression <b>${pc(r.repression||0)}</b> · Légitimité <b>${pc(r.legitimacy||0.5)}</b>`; }
    case 'Marché des moyens': return `Machines <b>niv. ${s.niveauMachine}</b> · Trésorerie <b>${m(s.argent)}</b> · Coût machine <b>${m(Math.round(300*costMul()))}</b>`;
    case 'Bourse': return `Bourse <b>${(s.buildings.bourse||0)>0?'active':'à fonder'}</b> · Dividendes <b>${m(s.dividende||0)}/période</b> · Crédit bonus <b>+${m(s.creditBonus||0)}</b> · Trésorerie <b>${m(s.argent)}</b>`;
    case 'Port · Marché mondial': return `Port <b>${(s.buildings.port||0)>0?'ouvert':'à ouvrir'}</b> · Débouchés <b>+${s.demandeBonus||0}</b> · Stocks <b>${Math.round(s.stocks)}</b> · Import bon marché <b>${(s.importCheap||0)>0?(s.importCheap+' pér.'):'—'}</b>`;
    default: return '';
  }
}
// (A) objectifs : leur accomplissement injecte du capital (≥500, croissant) et fait monter de niveau
const OBJECTIVES_SF=[
  {id:'profit', label:'Dégager un profit sur une période', check:s=>(s.d&&(s.d.resultatNet||0)>0), r:120},
  {id:'emb5',   label:'Employer 5 ouvriers', check:s=>s.travailleurs>=5, r:160},
  {id:'mach2',  label:'Mécaniser : machine niveau 2', check:s=>s.niveauMachine>=2, r:220},
  {id:'stock',  label:'Agrandir la capacité de stockage', check:s=>(s.stockCapaciteBonus||0)>=1, r:260},
  {id:'part',   label:'Conquérir le marché (≥ 45 % de part)', check:s=>(s.d&&s.d.partJoueur!=null&&s.d.partJoueur>=0.45), r:320},
  {id:'manu',   label:'Atteindre la Manufacture', check:s=>(s.age||1)>=2, r:420},
  {id:'emb10',  label:'Employer 10 ouvriers', check:s=>s.travailleurs>=10, r:500},
  {id:'mach3',  label:'Machine niveau 3', check:s=>s.niveauMachine>=3, r:600},
  {id:'gi',     label:'Atteindre la Grande industrie', check:s=>(s.age||1)>=3, r:760},
  {id:'rails',  label:'Construire des rails', check:s=>(s.buildings.rails||0)>=1, r:850},
  {id:'ville',  label:'Atteindre la Ville industrielle', check:s=>(s.age||1)>=4, r:1000},
  {id:'bourse', label:'Fonder la Bourse (capital financier)', check:s=>(s.buildings.bourse||0)>=1, r:1200},
  {id:'cf',     label:'Atteindre le Capital financier', check:s=>(s.age||1)>=5, r:1400},
  {id:'port',   label:'Ouvrir le port (marché mondial)', check:s=>(s.buildings.port||0)>=1, r:1650},
  {id:'mm',     label:'Atteindre le Marché mondial', check:s=>(s.age||1)>=6, r:1900},
];
function currentObjective(s){ return OBJECTIVES_SF[s.objIndex||0]||null; }
// (issue 2) chaque action a une conséquence visuelle sur la carte : impact immédiat au lieu cliqué
// + flux causaux vers les zones réellement affectées (argent, ouvriers, colère qui se propagent)
function actionVisual(zoneName,label){
  if(typeof scene==='undefined'||!scene) return;
  const L=(label||'').toLowerCase(), Z=zoneName;
  const GOLD=COL.or, RED=COL.rouge, BLUE=COL.bleu, GREEN=COL.vert;
  const ft=(txt,where,type)=>{ try{ floatText(txt, zonePos(where||Z), type||'neutre'); }catch(e){} };
  const halo=(n,c)=>{ try{ fxHalo(n,c); }catch(e){} };
  const ping=(n,c)=>{ try{ fxPing(n,c); }catch(e){} };
  const puff=(n)=>{ try{ fxPuff(n); }catch(e){} };
  const crate=(a,b,c)=>{ try{ fxCrate(a,b,c); }catch(e){} };
  try{ flashTimer=Math.max(flashTimer||0,0.25); }catch(e){}
  // Bourse / capital financier
  if(L.includes('bourse')||L.includes('émettre')||L.includes('spéculer')){ halo('Bourse',GOLD); crate('Bourse','Banque',GOLD); ft(L.includes('spéculer')?'spéculation':'+ capital','Bourse',L.includes('spéculer')?'crise':'gain'); return; }
  // Port / marché mondial
  if(L.includes('port')||L.includes('exporter')||L.includes('importer')){ halo('Port · Marché mondial',BLUE); crate('Port · Marché mondial','Marché de vente',BLUE); ft('marché mondial','Port · Marché mondial','gain'); return; }
  // Banque
  if(L.includes('emprunter')){ halo('Banque',GOLD); crate('Banque','Usine',GOLD); ft('+ crédit','Banque','gain'); return; }
  if(L.includes('rembourser')){ halo('Banque',BLUE); crate('Usine','Banque',GOLD); ft('− dette','Banque','social'); return; }
  if(L.includes('renégocier')){ halo('Banque',BLUE); ft('taux ↓','Banque','social'); return; }
  // Machines
  if(L.includes('machine')){ crate('Marché des moyens','Usine',GOLD); halo('Usine',GOLD); puff('Usine'); ft('+ machine','Usine','gain'); return; }
  // Journée de travail
  if(L.includes('journée +')||L.includes('intensifier')){ puff('Usine'); halo('Usine',RED); ping('Quartier ouvrier',RED); ft('+ plus-value','Usine','gain'); ft('+ fatigue','Quartier ouvrier','crise'); return; }
  if(L.includes('réduire la journée')){ halo('Usine',BLUE); ft('− fatigue','Usine','social'); return; }
  if(L.includes('sécurité')){ halo('Usine',BLUE); ft('− accidents','Usine','social'); return; }
  if(L.includes('rails')){ halo('Usine',GOLD); crate('Usine','Entrepôt',GOLD); crate('Entrepôt','Marché de vente',GOLD); ft('rails','Usine','gain'); return; }
  // Marché du travail
  if(L.includes('embaucher')){ crate('Marché du travail','Usine',BLUE); halo('Usine',GOLD); ft('+1 ouvrier','Usine','gain'); return; }
  if(L.includes('licencier')){ ping('Marché du travail',RED); crate('Usine','Quartier ouvrier',RED); ping('Quartier ouvrier',RED); ft('+ chômage','Quartier ouvrier','crise'); return; }
  if(L.includes('augmenter les salaires')){ crate('Banque','Quartier ouvrier',GOLD); halo('Quartier ouvrier',GREEN); ft('+ salaire','Quartier ouvrier','social'); return; }
  if(L.includes('baisser les salaires')){ ping('Quartier ouvrier',RED); ft('+ colère','Quartier ouvrier','crise'); return; }
  // Entrepôt
  if(L.includes('liquider')){ crate('Entrepôt','Banque',GOLD); puff('Entrepôt'); ft('+ trésorerie','Entrepôt','gain'); return; }
  if(L.includes('agrandir')){ halo('Entrepôt',GOLD); ft('+ capacité','Entrepôt','gain'); return; }
  // Marché de vente
  if(L.includes('baisser les prix')){ halo('Marché de vente',GREEN); crate('Quartier ouvrier','Marché de vente',BLUE); ft('+ ventes','Marché de vente','social'); return; }
  if(L.includes('augmenter les prix')){ ping('Marché de vente',RED); ft('+ marge · − ventes','Marché de vente','crise'); return; }
  if(L.includes('élargir')){ halo('Marché de vente',GOLD); ft('+ débouchés','Marché de vente','gain'); return; }
  // Quartier ouvrier
  if(L.includes('logements')){ crate('Banque','Quartier ouvrier',GOLD); halo('Quartier ouvrier',GREEN); ft('+ logements','Quartier ouvrier','social'); return; }
  if(L.includes('négocier')){ halo('Quartier ouvrier',BLUE); ft('− colère','Quartier ouvrier','social'); return; }
  // État
  if(L.includes('loi sociale')){ halo('État · Tribunal',BLUE); crate('État · Tribunal','Quartier ouvrier',BLUE); ft('droits ↑','Quartier ouvrier','social'); return; }
  if(L.includes('réprimer')){ ping('État · Tribunal',RED); ping('Quartier ouvrier',RED); ft('répression','Quartier ouvrier','crise'); return; }
  // défaut : impact doré au lieu cliqué
  halo(Z,GOLD);
}
function checkObjectives(){
  const s=state; if(s.objIndex==null) s.objIndex=0;
  let safety=0;
  while(s.objIndex<OBJECTIVES_SF.length && safety++<12){
    const o=OBJECTIVES_SF[s.objIndex];
    if(!o.check(s)) break;
    const reward=Math.round(Math.max(o.r, capitalProductif(s)*0.22));  // v20 : récompenses utiles mais non explosives
    s.argent+=reward; s.objIndex++; s.niveau=(s.niveau||1)+1;
    flashTimer=Math.max(flashTimer,0.8);
    pushLog('Objectif',`« ${o.label} » accompli — capital injecté : +${money(reward)}. Niveau ${s.niveau}.`,'good');
    addHistoricalEvent('objectif',`Objectif atteint : ${o.label} (+${money(reward)}, niveau ${s.niveau}).`);
    if(typeof showLevelUp==='function') showLevelUp(s.niveau, o.label, reward);
    if(typeof floatText==='function'){ try{ floatText(`+${money(reward)} · Niveau ${s.niveau}`, (typeof vehicle!=='undefined'&&vehicle)?vehicle.position:null, 'good'); }catch(e){} }
  }
}
let _levelupEl=null;
function showLevelUp(level,label,reward){
  try{
    if(!_levelupEl){ _levelupEl=document.createElement('div'); _levelupEl.id='levelup';
      (document.body||document.documentElement).appendChild(_levelupEl); }
    _levelupEl.innerHTML='<div class="lu-k">Niveau supérieur</div><div class="lu-n">Niveau '+level+'</div>'
      +'<div class="lu-o">'+label+'</div>'
      +'<div class="lu-g">Gain : +'+money(reward)+'  ·  Capital : '+money(state.argent)+'</div>';
    _levelupEl.classList.add('show');
    if(_levelupEl._t) clearTimeout(_levelupEl._t);
    _levelupEl._t=setTimeout(()=>{ if(_levelupEl) _levelupEl.classList.remove('show'); }, 3800);
  }catch(e){}
}
function openZoneActions(zone){
  const list=ZONE_ACTIONS[zone.name];
  document.getElementById('za-title').textContent=displayZoneName(zone.name);
  const left=state.actionsRestantes;
  document.getElementById('za-actions').textContent=left+' action'+(left>1?'s':'')+' restante'+(left>1?'s':'');
  const stEl=document.getElementById('za-state'); if(stEl) stEl.innerHTML=zoneReadout(zone.name,state);
  const box=document.getElementById('za-list'); box.innerHTML='';
  if(!list||!list.length){ box.innerHTML='<p style="opacity:.7;font-size:13px">Pas d’intervention directe ici : observe, ou agis ailleurs.</p>'; }
  else list.forEach(a=>{ const b=document.createElement('button'); b.className='za';
    const ok=(left>0)&&(!a.can||a.can(state)); b.disabled=!ok;
    b.innerHTML=`<b>${a.label}</b><span class="s">${a.sub}</span>`;
    b.onclick=()=>doZoneAction(zone,a); box.appendChild(b); });
  document.getElementById('zoneact').classList.add('on'); refreshModalMode();
}
function doZoneAction(zone,a){
  if(state.actionsRestantes<=0 || (a.can&&!a.can(state))) return;
  a.run(); state.actionsRestantes--;
  if(typeof actionVisual==='function') actionVisual(zone.name, a.label);
  if(typeof LWmicro!=='undefined') LWmicro(zone.name);
  if(typeof updateBuildings==='function') updateBuildings();   // toute amélioration change le monde visuellement
  if(typeof updateZoneVisibility==='function') updateZoneVisibility();
  updateHUD(); updateConsequences(); renderFormationPanel();
  if(state.actionsRestantes<=0){ document.getElementById('zoneact').classList.remove('on'); refreshModalMode();
    pushLog('Période','Plus d’actions disponibles. Lance le cycle productif depuis le panneau Formation sociale.','warn'); tutorialCoachRefresh(true); }
  else openZoneActions(zone);
}

const AGE_RULES_DESC={
  0:'Argent dormant',
  1:'Survie · faible concurrence · petit atelier',
  2:'Division du travail · concurrence intense · revendications collectives',
  3:'Chômage structurel · surproduction · crises violentes · État présent',
  4:'Ville industrielle · rails · organisation ouvrière puissante',
  5:'Capital financier · Bourse · dividendes · crises plus violentes',
  6:'Marché mondial · Port · débouchés massifs · crise globalisée',
};
const AGE_RULE_BODY={
  2:'La <b>division du travail</b> augmente la productivité, mais elle rassemble les ouvriers : les revendications deviennent collectives et la concurrence se durcit.',
  3:'La <b>grande industrie</b> impose ses lois : la machine crée un <b>chômage structurel</b> (une armée de réserve permanente), la <b>surproduction</b> menace, les crises frappent plus fort, et l’<b>État</b> doit intervenir davantage.',
  4:'La <b>ville industrielle</b> : rails et wagons font circuler les marchandises, le marché s’élargit, le quartier ouvrier se densifie. L’<b>organisation ouvrière</b> devient une puissance avec laquelle il faut compter.',
  5:'Le <b>capital financier</b> domine : la Bourse permet de lever du capital en <b>émettant des actions</b>, mais impose des <b>dividendes</b> à servir chaque période, et la spéculation rend les <b>crises plus violentes</b>.',
  6:'Le <b>marché mondial</b> s’ouvre : le port donne des <b>débouchés massifs</b> et des matières premières bon marché — mais expose toute la formation sociale à une <b>crise globalisée</b>, plus profonde.',
};
// chaque âge remanie les règles — effets structurels appliqués après le cycle
function applyAgeRules(s){
  const age=s.age||1, r=s.regime||{};
  s.ageRules=AGE_RULES_DESC[age]||AGE_RULES_DESC[1];
  if(age>=2 && s.competitors){            // concurrence plus intense
    s.competitors.forEach(c=>{ if(c.vivant) c.prix=Math.max(1.05,c.prix-0.01); });
  }
  if(age>=3){                             // grande industrie : règles plus dures
    const reserve=Math.round(s.travailleurs*0.3 + s.niveauMachine*1.5);
    s.populationActive=Math.max(s.populationActive, s.travailleurs+reserve);   // armée de réserve permanente
    if(r.statePower!=null) r.statePower=Math.max(r.statePower,0.4);             // État plus présent
    if(s.d && s.d.declenche){                                                   // crise plus violente
      const hit=Math.round(s.argent*0.06); s.argent-=hit; s.colere=clamp(s.colere+0.05);
      addHistoricalEvent('crise',`Crise industrielle : la surproduction frappe fort (−${hit} £, colère ↑).`);
    }
  }
  if(age>=4){                             // ville industrielle : rails actifs, marché élargi
    s.demandeBonus=Math.max(s.demandeBonus||0,2);
    if((s.buildings.rails||0)<1){ s.buildings.rails=1; if(typeof updateBuildings==='function') updateBuildings(); }
    s.railsBonus=Math.max(s.railsBonus||0,0.3);
  }
  if(age>=5){                             // capital financier : dividendes + crises plus violentes
    s.plafondCredit=Math.max(s.plafondCredit||500,1400);
    if((s.dividende||0)>0) s.argent-=Math.round(s.dividende);                          // dividendes servis chaque période
    if(s.d && s.d.declenche){ const hit=Math.round(Math.max(0,s.argent)*0.05); if(hit>0){ s.argent-=hit; addHistoricalEvent('crise',`Panique financière : la Bourse amplifie la crise (−${money(hit)}).`); } }
  }
  if(age>=6){                             // marché mondial : débouchés massifs, crise globalisée
    s.demandeBonus=Math.max(s.demandeBonus||0,6);
    if((s.buildings.port||0)<1){ s.buildings.port=1; if(typeof updateBuildings==='function') updateBuildings(); }
    if(s.d && s.d.declenche){ s.colere=clamp(s.colere+0.04); addHistoricalEvent('crise','La crise se propage par le marché mondial : aucune économie n’y échappe.'); }
  }
  if((s.importCheap||0)>0){ s.argent+=Math.round(8+s.travailleurs*1.5); s.importCheap--; } // matières importées bon marché
}
function checkAgeTransition(){ const s=state; let to=null;
  if((s.age||1)<=1 && canReachManufacture(s)) to=2;
  else if(s.age===2 && canReachGrandeIndustrie(s)) to=3;
  else if(s.age===3 && canReachVilleIndustrielle(s)) to=4;
  else if(s.age===4 && canReachCapitalFinancier(s)) to=5;
  else if(s.age===5 && canReachMarcheMondial(s)) to=6;
  if(to && to>(s.age||1)){ s.age=to; s.niveauVille=Math.max(s.niveauVille,to);
    if(typeof refreshNiveauVille==='function') refreshNiveauVille();
    if(typeof updateBuildings==='function') updateBuildings();
    if(typeof updateEnvironmentByStage==='function') updateEnvironmentByStage();
    if(typeof updateVilleBadge==='function') updateVilleBadge();
    if(typeof buildSocialTableau==='function') buildSocialTableau();   // la carte se restructure (la ville naît)
    flashTimer=1.6; const name=AGES[to];
    // déflagration visuelle qui balaie toute la carte
    ['Usine','Quartier ouvrier','Marché de vente','Banque','Entrepôt','Marché du travail','État · Tribunal','Bourse','Port · Marché mondial'].forEach((n,i)=>{
      if(typeof fxPing==='function') fxPing(n); if(typeof fxHalo==='function') fxHalo(n,COL.or); });
    addHistoricalEvent('age',`La formation sociale bascule dans l’âge : ${name}. La carte se restructure.`);
    const ruleLine=AGE_RULE_BODY[to]?`<p>${AGE_RULE_BODY[to]}</p>`:'';
    const villeLine=(to===3)?'<p>La grande industrie <b>suppose la ville</b> : autour de l’usine, des rues, des immeubles et une place s’étendent — la carte devient une véritable ville.</p>':'';
    showConcept({stamp:'Âge historique', title:name,
      body:`<p>Le développement du capital fait passer la formation sociale dans un nouvel âge : <b>${name}</b>.</p>${villeLine}${ruleLine}`,
      unlock:AGE_UNLOCKS[to]||[]});
    return true; }
  return false;
}
function evaluateHistoricalBifurcations(s){ const r=s.regime; if(!r) return;
  if(s._bifCooldown>0){ s._bifCooldown--; return; }
  const g=s.groups||{}; const rev=(g.revolutionaries?g.revolutionaries.force:0), org=(g.workers?g.workers.organisation:0),
        unions=(g.unions?g.unions.reconnaissance:0), workerForce=(g.workers?g.workers.force:0);
  // poussée révolutionnaire — portée par les forces organisées, non par la seule colère
  if((rev>0.55 || (r.revolutionaryPotential>0.65 && org>0.5)) && r.legitimacy<0.4){
    addHistoricalEvent('crise','Poussée révolutionnaire : la classe ouvrière organisée conteste l’ordre du capital.');
    s.colere=clamp(s.colere-0.1); s._bifCooldown=3; flashTimer=0.7; return; }
  // durcissement autoritaire — l'État réprime une force ouvrière montante
  if(r.repression>0.5 && (workerForce>0.5 || s.colere>0.5) && r.authoritarianDrift>0.4){
    addHistoricalEvent('crise','Durcissement autoritaire : l’État réprime ; la paix sociale est imposée par la force.');
    s.colere=clamp(s.colere-0.12); s.conscience=clamp(s.conscience+0.06); s._bifCooldown=3; return; }
  // compromis social — des syndicats reconnus canalisent le conflit
  if((unions>0.4 || (r.socialRights>0.4 && r.legitimacy>0.55)) && s.colere<0.42){
    addHistoricalEvent('social','Compromis social : syndicats reconnus, conflits canalisés dans des institutions.');
    r.socialDemocraticDrift=clamp(r.socialDemocraticDrift+0.1); s._bifCooldown=4; return; }
}
function generativeChronicle(){
  const s=state, d=s.d||{}, bits=[];
  const net=(d.resultatNet!=null?d.resultatNet:(d.profitRealise||0));
  if(d.declenche) bits.push('crise de réalisation');
  else if(net>5) bits.push('profit réalisé : '+money(net));
  else if(net<-5) bits.push('perte nette : '+money(Math.abs(net)));
  else bits.push('cycle presque à l’équilibre');
  if(s.dette>250) bits.push('dette élevée : '+money(s.dette));
  if(s.stocks>100) bits.push('stocks critiques : '+Math.round(s.stocks));
  if(s.colere>0.5) bits.push('colère ouvrière : '+pct(s.colere));
  if(s.chomage>0.4) bits.push('chômage : '+pct(s.chomage));
  addHistoricalEvent('chronique',`Cycle ${s.cycle} — ${bits.join(' · ')}.`);
}


/* =====================================================================
   v48 — COMPETITOR WORLD
   « Le capital n'est jamais seul : il existe toujours comme concurrence
   entre capitaux. »
   Ce module incarne les concurrents de CompetitionSystem :
   - un district visible par firme (atelier, dépôt, ouvriers, fumée, prix) ;
   - un comportement autonome par stratégie, joué à chaque période ;
   - une lecture du monde sans menu (prospérité, crise, grève, faillite) ;
   - l'observation sur place (gratuite, approximative) et le rapport
     détaillé (1 action) ; le rachat des faillites (concentration) ;
   - un classement industriel et des événements autonomes au journal.
   Division du travail avec le moteur : CompetitionSystem reste maître des
   prix, parts de marché et faillites ; CompetitorWorld anime ouvriers,
   machines, stocks, colère, âges, espace — et raconte ce qui se passe.
   ===================================================================== */
const CompetitorWorld={
  revealed:false,
  _events:[],          // événements de la période en cours (max 2 émis, faillites/âges prioritaires)

  firms(){ return state.competitors||[]; },
  byZone(name){ return this.firms().find(c=>c.zoneName===name); },

  /* ---------- construction des districts (appelé par init, cachés au départ) ---------- */
  build(){
    for(const c of this.firms()){
      c.zoneName='⚒ '+c.nom;
      const g=new THREE.Group(); g.position.set(c.district.x,0,c.district.z); g.visible=false;
      // socle permanent : dalle de quartier, enseigne, halo — même emprise au sol que les zones du joueur.
      const dalle=new THREE.Mesh(new THREE.CircleGeometry(8.5,28),
        new THREE.MeshStandardMaterial({color:0xb9a884,roughness:1,transparent:true,opacity:.55}));
      dalle.rotation.x=-Math.PI/2; dalle.position.y=0.03; g.add(dalle);
      const lab=makeLabel(c.nom); lab.position.set(0,10,0); g.add(lab);
      const halo=new THREE.Mesh(new THREE.RingGeometry(8.4,9.2,40),
        new THREE.MeshBasicMaterial({color:c.couleur,transparent:true,opacity:.32,side:THREE.DoubleSide}));
      halo.rotation.x=-Math.PI/2; halo.position.y=0.04; g.add(halo);
      scene.add(g);
      zoneGroups[c.zoneName]=g; c._group=g;
      zones.push({name:c.zoneName,pos:new THREE.Vector3(c.district.x,0,c.district.z),radius:9,key:'',group:g,halo,
        action:()=>[c.nom, this.promptInfo(c)]});
      obstacles.push({pos:new THREE.Vector2(c.district.x,c.district.z),radius:5.5});
    }
    this.refreshVisuals();
  },

  /* révélation à l'entrée en formation sociale : le monde dépasse le joueur */
  reveal(){
    if(this.revealed) return;
    this.revealed=true;
    for(const c of this.firms()){ if(c._group) c._group.visible=true; }
    PlayerDistrict.mark(); PlayerDistrict.refreshHousing(); CityGrowth.update();
    this.refreshVisuals(); this.renderRanking();
    addHistoricalEvent('age','D’autres capitaux étaient déjà là : Brandt, Verrié et Halage empruntent à la même banque, embauchent sur le même marché du travail et vendent sur la même place que toi. Ensemble, vous ferez la ville.');
    pushLog('Concurrence','Trois quartiers d’entreprise apparaissent autour des mêmes marchés que toi. Va les observer : le capital n’est jamais seul.','warn');
  },

  /* ---------- état lisible sans menu ---------- */
  etat(c){
    if(!c.vivant) return c.rachete?'racheté':'en faillite';
    if(c.enGreve) return 'en grève';
    if(c.debt>260||c.capital<120) return 'endetté · fragile';
    if(c.capital>520) return 'en expansion';
    return 'stable';
  },
  /* observation gratuite : approximations — l'exactitude se paie (rapport détaillé) */
  fuzzyPrice(c){ const r=state.prixUnitaire||1.4; return c.prix<r*0.93?'prix bas':c.prix>r*1.07?'prix élevés':'prix proches des tiens'; },
  fuzzy(c){
    return [
      this.fuzzyPrice(c),
      c.debt>260?'fortement endettée':c.debt>120?'endettée':'dette faible',
      c.workers>=9?'ouvriers nombreux':'effectif réduit',
      c.machineLevel>=3?'production intense (machines)':'production artisanale',
      c.anger>0.55?'tension sociale visible':null,
      c.stocks>40?'caisses qui s’entassent':null
    ].filter(Boolean).join(' · ');
  },
  promptInfo(c){
    if(!c.vivant && !c.rachete) return 'FAILLITE — actifs abandonnés. Appuie sur E : rachat possible.';
    return STAGE_NAME[c.stage]+' · '+this.etat(c)+' · '+this.fuzzy(c);
  },

  /* ---------- panneau d'observation (réutilise la fenêtre de lieu) ---------- */
  openPanel(c){
    document.getElementById('za-title').textContent=c.nom;
    const left=state.actionsRestantes;
    document.getElementById('za-actions').textContent=left+' action'+(left>1?'s':'')+' restante'+(left>1?'s':'');
    const stEl=document.getElementById('za-state');
    if(c.spied){
      stEl.innerHTML=`<b>${STAGE_NAME[c.stage]}</b> — stratégie : <b>${c.devise}</b><br>`+
        `Prix <b>${money2(c.prix)}</b> · Part de marché <b>${pct(c.part||0)}</b> · Capital <b>${money(c.capital)}</b> · Dette <b>${money(c.debt)}</b><br>`+
        `Ouvriers <b>${c.workers}</b> · Machines <b>niv. ${c.machineLevel}</b> · Salaire <b>${money(c.wage)}</b> · Stocks <b>${Math.round(c.stocks)}</b><br>`+
        `Colère locale <b>${pct(c.anger)}</b> · État : <b>${this.etat(c)}</b>`+
        (c.vivant?'':'<br><b style="color:var(--rouge)">EN FAILLITE — actifs rachetables</b>');
    } else {
      stEl.innerHTML=`<b>${STAGE_NAME[c.stage]}</b> · ${this.etat(c)}<br>${this.fuzzy(c)}<br><i style="opacity:.7">Observation à l’œil nu : approximative. Un rapport détaillé coûte 1 action.</i>`;
    }
    const box=document.getElementById('za-list'); box.innerHTML='';
    const mk=(label,sub,ok,fn)=>{ const b=document.createElement('button'); b.className='za'; b.disabled=!ok;
      b.innerHTML=`<b>${label}</b><span class="s">${sub}</span>`; b.onclick=fn; box.appendChild(b); };
    if(c.vivant && !c.spied)
      mk('Commander un rapport détaillé','espionnage économique · révèle prix, dette, stocks, stratégie · 1 action',
        left>0, ()=>{ c.spied=true; state.actionsRestantes--; renderFormationPanel();
          pushLog('Observation',`Rapport sur ${c.nom} : stratégie « ${c.devise} ».`,'plain'); this.openPanel(c); });
    if(!c.vivant && !c.rachete){
      const cost=this.buyoutCost(c);
      mk('Racheter les actifs ('+money(cost)+')',
        'machines + ouvriers absorbés + stocks bradés · concentration du capital · 1 action',
        left>0 && state.argent>=cost, ()=>{ this.buyout(c); });
    }
    document.getElementById('zoneact').classList.add('on'); refreshModalMode(); tutorialCoachRefresh(true);
  },

  buyoutCost(c){ return Math.round(160 + c.machineLevel*90 + c.stocks*0.4); },
  buyout(c){
    const cost=this.buyoutCost(c);
    if(state.argent<cost || state.actionsRestantes<=0) return;
    state.argent-=cost; state.actionsRestantes--;
    state.niveauMachine+=1;                                  // ses machines partent pour une bouchée de pain
    const absorbes=Math.min(3,c.workers);
    state.travailleurs+=absorbes; state.populationActive=Math.max(state.populationActive,state.travailleurs);
    state.stocks+=Math.round(c.stocks*0.5);
    state._investedThisCycle=true;
    c.rachete=true; c.workers=0; c.stocks=0;
    if(typeof recomputeProduction==='function') recomputeProduction();
    addHistoricalEvent('crise',`${c.nom} est absorbée : machines récupérées, ${absorbes} ouvriers repris, le capital se concentre.`);
    pushLog('Concentration',`Rachat de ${c.nom} (−${money(cost)}) : +1 niveau de machine, +${absorbes} ouvriers, stocks récupérés.`,'warn');
    this.updateConcentration(); this.refreshVisuals(); this.renderRanking();
    updateHUD(); updateConsequences(); renderFormationPanel();
    document.getElementById('zoneact').classList.remove('on'); refreshModalMode();
  },

  /* ---------- comportement autonome : une décision par firme et par période ---------- */
  onPeriod(){
    if(!this.revealed) return;
    this._events=[];
    const demande=(state.d&&state.d.demande)||450;
    for(const c of this.firms()){
      if(!c.vivant){ this.markDeath(c); continue; }
      const prevCap=c._lastCap!=null?c._lastCap:c.capital;
      // production/vente approchées (l'argent exact est tenu par CompetitionSystem ; ici : matérialité)
      // échelle ~ joueur : ouvriers × 9 h × productivité ; la grève réduit à 15 %
      const prod=(c.enGreve?0.15:1) * c.workers*9*c.productivite*(1+0.3*(c.machineLevel-1));
      // friction de réalisation : on ne capte jamais toute sa demande -> les stocks deviennent visibles
      const ventes=Math.min(prod+c.stocks, 0.92*(c.part||0.2)*demande/Math.max(0.4,c.prix));
      c.stocks=Math.max(0,Math.min(300,c.stocks+prod-ventes));
      c.enGreve=false;
      this['strat_'+(c.strat==='bas-salaires'?'bas':c.strat)](c,prevCap);
      // pertes -> licenciements (l'armée de réserve grossit pour tout le monde)
      if(!c._justInvested && c.capital<prevCap-30 && c.workers>3 && Math.random()<0.5){
        const lic=1+Math.round(Math.random());
        c.workers-=lic; c.anger=clamp(c.anger+0.05);
        state.populationActive+=lic;                       // chômage global ↑ -> demande ↓, pression salariale
        this.queue(`${c.nom} licencie ${lic} ouvrier${lic>1?'s':''} : l’armée de réserve grossit.`,'social');
      }
      // passage d'âge autonome : un concurrent peut atteindre la Manufacture avant le joueur
      if(c.stage===1 && c.machineLevel>=3){
        c.stage=2; c.productivite*=1.12;
        const avant=(state.age||1)<2;
        this.queue(`${c.nom} atteint la Manufacture${avant?' — avant toi':''} : sa productivité bondit, ses prix baisseront plus vite.`, 'crise', true);
        if(avant) pushLog('⚠ Pression historique',`${c.nom} a changé d’échelle avant toi. Suis le rythme de l’accumulation — ou perds tes débouchés.`,'warn');
      }
      if(c.stage===2 && c.machineLevel>=6){
        c.stage=3; c.productivite*=1.10; state.populationActive+=2;
        this.queue(`${c.nom} passe à la grande industrie : machines massives, chômage accru, marché saturé.`, 'crise', true);
      }
      c._lastCap=c.capital; c._justInvested=false;
      c.debt=Math.max(0,c.debt);
    }
    // un seul marché du travail : si on paie mieux ailleurs, tes ouvriers le savent
    const alive2=this.firms().filter(c=>c.vivant);
    if(alive2.length){
      const wmax=Math.max(...alive2.map(c=>c.wage));
      state._wageEnvyCd=Math.max(0,(state._wageEnvyCd||0)-1);
      if(wmax>state.salaire && state._wageEnvyCd===0 && Math.random()<0.45){
        state.colere=clamp(state.colere+0.025); state._wageEnvyCd=3;
        const qui=alive2.find(c=>c.wage===wmax);
        this.queue(`On paie ${wmax} £ chez ${qui.nom} : tes ouvriers comparent, la pression salariale monte.`,'social');
      }
    }
    this.priceWar();
    this.updateConcentration();
    this.emitEvents();
    refreshPlayerPlant();              // v53 : ton bâtiment suit ton âge — même grammaire que les leurs
    PlayerDistrict.refreshHousing();   // v50 : tes logements suivent ton effectif, comme chez eux
    CityGrowth.update();               // v50 : la ville avance au rythme du développement collectif
    this.refreshVisuals();
    this.renderRanking();
  },

  /* stratégies — comportements reconnaissables, résultats visibles */
  strat_mecanise(c){
    // la mécanisation se finance à crédit : c'est précisément sa stratégie (et sa fragilité)
    if(c.capital>280 && Math.random()<0.65){
      c.machineLevel++; c.capital-=100; c.debt+=120; c.prix=Math.max(0.7,c.prix*0.97); c._justInvested=true; c._justInvestedVisible=true;
      if(c.workers>4 && Math.random()<0.6){ c.workers--; c.anger=clamp(c.anger+0.07); state.populationActive+=1; }
      this.queue(`${c.nom} installe une machine et baisse ses prix.`,'plain');
    }
    c.anger=clamp(c.anger+0.02-0.01*Math.random());
  },
  strat_bas(c){
    c.wage=4; c.anger=clamp(c.anger+0.06-0.02*Math.random());
    if(c.anger>0.62 && Math.random()<0.5){
      c.enGreve=true; c.capital-=45; c.anger=clamp(c.anger-0.18);
      this.queue(`Grève chez ${c.nom} : la production s’arrête, la colère déborde l’atelier.`,'social', true);
      // contagion : les ouvriers du joueur regardent ailleurs
      state.conscience=clamp(state.conscience+0.04);
      if(state.salaire<=4){ state.colere=clamp(state.colere+0.04);
        this.queue('La grève voisine fait école : tes ouvriers comparent leurs salaires.','social'); }
    } else if(c.capital>380 && Math.random()<0.4){ c.workers++; }
  },
  strat_compromis(c){
    c.debt=Math.max(0,c.debt-15);
    if(Math.random()<0.22 && c.capital>300) c.workers++;
    if(Math.random()<0.16 && c.capital>520){ c.machineLevel++; c.capital-=180; c._justInvested=true; this.queue(`${c.nom} mécanise prudemment.`,'plain'); }
    c.anger=clamp(c.anger-0.02);
  },

  /* guerre des prix : vendre nettement sous le marché force des réponses */
  priceWar(){
    if(state._priceWarCd>0){ state._priceWarCd--; return; }
    const alive=this.firms().filter(c=>c.vivant);
    if(!alive.length) return;
    const minConc=Math.min(...alive.map(c=>c.prix));
    if(state.prixUnitaire < minConc*0.90){
      alive.forEach(c=>{ c.prix=Math.max(0.6,c.prix*0.94); c.capital-=35; });
      state._priceWarCd=3;
      this.queue('GUERRE DES PRIX : les concurrents s’alignent, les marges chutent, les plus endettés vacillent.','crise', true);
      if(typeof fxHalo==='function') alive.forEach(c=>fxHalo(c.zoneName,COL.rouge));
    }
  },

  /* concentration : faillites -> oligopole -> quasi-monopole (état rare et problématique) */
  updateConcentration(){
    const parts=[(state.d&&state.d.partJoueur)||0.25,...this.firms().filter(c=>c.vivant).map(c=>c.part||0)];
    const hhi=parts.reduce((a,b)=>a+b*b,0);             // 0.25 = 4 acteurs égaux · 1 = monopole
    state.marketConcentration=clamp((hhi-0.25)/0.75);
    if(state.marketConcentration>0.45 && !state._oligopoleVu){
      state._oligopoleVu=true;
      this.firms().filter(c=>c.vivant).forEach(c=>c.prix=Math.min(2.1,c.prix*1.04));
      state.colere=clamp(state.colere+0.03);
      this.queue('Le marché se concentre : les survivants relèvent les prix. L’État et la rue observent.','crise', true);
    }
  },

  markDeath(c){
    if(c._deadSeen) return;
    c._deadSeen=true;
    state.populationActive+=Math.min(3,c.workers);   // le quartier tombe au chômage
    this.queue(`Faillite de ${c.nom}. Bâtiments fermés, ouvriers à la rue — ses actifs sont rachetables sur place.`,'crise', true);
  },

  /* journal : 2 événements ordinaires max par période ; faillites/âges toujours émis */
  queue(text,type,prioritaire){ this._events.push({text,type:type||'plain',prioritaire:!!prioritaire}); },
  emitEvents(){
    const prio=this._events.filter(e=>e.prioritaire);
    const norm=this._events.filter(e=>!e.prioritaire).slice(0,2);
    [...prio,...norm].forEach(e=>{ addHistoricalEvent(e.type==='plain'?'chronique':e.type, e.text); pushLog('Concurrence',e.text,e.type==='plain'?'plain':e.type==='crise'?'crisis':'social'); });
    this._events=[];
  },

  /* ---------- le district raconte l'état de la firme, sans menu ---------- */
  refreshVisuals(){
    // Les prix sont PUBLICS sur la place du marché : chaque firme y affiche son panneau.
    // (l'espionnage, lui, révèle ce que le marché ne montre pas : dette, stocks, stratégie)
    const mv=zoneGroups['Marché de vente'];
    if(mv){ clearLayer(mv,'concprices');
      if(this.revealed){
        const alive=this.firms().filter(c=>c.vivant);
        alive.forEach((c,i)=>{
          const pb=createPriceBoard(String(Math.round(c.prix*100)/100));
          pb.position.set(-5.5+i*5.5,0,10.5); tagLayer(pb,'concprices'); mv.add(pb);
          const ring=new THREE.Mesh(new THREE.RingGeometry(0.7,1.0,20),
            new THREE.MeshBasicMaterial({color:c.couleur,transparent:true,opacity:.6,side:THREE.DoubleSide}));
          ring.rotation.x=-Math.PI/2; ring.position.set(-5.5+i*5.5,0.05,10.5); tagLayer(ring,'concprices'); mv.add(ring);
        });
      }
    }
    for(const c of this.firms()){
      const g=c._group; if(!g) continue;
      clearLayer(g,'cw');
      const add=m=>{ tagLayer(m,'cw'); g.add(m); return m; };
      // --- v53 : MÊMES bâtisseurs que le joueur — un atelier est un atelier, chez tous ---
      PLANT_BUILDERS[Math.min(3,Math.max(1,c.stage||1))](g,add);
      // logements ouvriers : 1 maison pour 4 ouvriers — le quartier se peuple comme celui du joueur
      const houses=Math.min(3,Math.floor(c.workers/4));
      for(let i=0;i<houses;i++){ const h=createWorkerHouse(3.0,COL.froid);
        h.position.set(-8.5+i*3.4,0,-6.5); h.rotation.y=0.18*(i-1); add(h); }
      // caisses du dépôt ∝ stocks (invendus visibles)
      const n=Math.min(8,Math.floor(c.stocks/12));
      for(let i=0;i<n;i++) add(createCrate(1.3,0x8a6b49)).position.set(-9.5+(i%4)*1.8,0.65,2.8+Math.floor(i/4)*1.8);
      // ouvriers ∝ effectif, dans la cour (mêmes proportions que le tableau du joueur)
      const w=Math.min(5,Math.ceil(c.workers/2.5));
      for(let i=0;i<w;i++){
        // M-Peuple-proc : ouvriers de la firme en travail (anim work).
        // Tint = couleur de la firme pour distinguer visuellement.
        const f = spawnFigure({ type:'ouvrier', anim:'work', tint: c.couleur });
        f.position.set(-4+i*2.1,0,6.6); f.rotation.y=Math.PI; add(f);
      }
      // machines visibles ∝ mécanisation
      for(let i=0;i<Math.min(4,c.machineLevel-1);i++){
        const m=new THREE.Mesh(new THREE.CylinderGeometry(0.8,0.8,1.2,10),
          new THREE.MeshStandardMaterial({color:0x4b4438,metalness:.3,roughness:.6,flatShading:true}));
        m.rotation.z=Math.PI/2; m.position.set(4.5,0.9,1.5+i*1.6); add(m);
      }
      // fumée = activité ; pas de fumée = arrêt
      const active=c.vivant&&!c.enGreve;
      if(active && c.stage<3){ const sm=new THREE.Mesh(new THREE.SphereGeometry(0.6,8,8),
          new THREE.MeshStandardMaterial({color:COL.fumee,transparent:true,opacity:0.3,flatShading:true}));
        sm.position.set(c.stage===2?-3.6:2.8, c.stage===2?10.4:8.4, c.stage===2?-3:-1.8);
        sm.userData.chimney=true; add(sm); }   // v63 : émetteur — les bouffées montent et se dissipent
      // grève : piquet devant la porte
      if(c.enGreve){ const bar=box(8,0.45,0.45,COL.rouge,0,2,5.4,false); add(bar);
        const sg=makeLabel('GRÈVE'); sg.scale.set(5,1.3,1); sg.position.set(0,6.5,5.4); add(sg); }
      // état terminal : faillite / rachat
      if(!c.vivant){
        const veil=new THREE.Mesh(new THREE.CircleGeometry(9,28),
          new THREE.MeshBasicMaterial({color:0x1a1712,transparent:true,opacity:c.rachete?0.18:0.42,depthWrite:false}));
        veil.rotation.x=-Math.PI/2; veil.position.y=0.05; add(veil);
        const sg=makeLabel(c.rachete?'RACHETÉ':'FAILLITE — FERMÉ'); sg.scale.set(8,1.5,1); sg.position.set(0,7.5,3); add(sg);
        if(!c.rachete) for(let i=0;i<3;i++){
          // M-Peuple-proc : ouvriers licenciés dehors — type chomeur.
          const f = spawnFigure({ type:'chomeur', anim:'idle' });
          f.position.set(-4+i*3,0,8.5); add(f);
        }
      }
      // au district : pas de prix (il s'affiche sur le marché COMMUN) — juste l'enseigne d'activité
      const pb=createPriceBoard(c.vivant?'⚒':'✕');
      pb.position.set(6.8,0,4.5); add(pb);
    }
  },

  /* ---------- classement industriel ---------- */
  ranking(){
    const rows=[{me:true,nom:'Toi',stage:STAGE_NAME[Math.min(3,state.age||1)]||'Atelier',part:(state.d&&state.d.partJoueur)||0,etat:'—',couleur:0xa8812c,vivant:true}];
    for(const c of this.firms()) rows.push({me:false,nom:c.nom,stage:STAGE_NAME[c.stage],part:c.vivant?(c.part||0):0,etat:this.etat(c),couleur:c.couleur,vivant:c.vivant});
    rows.sort((a,b)=>b.part-a.part);
    return rows;
  },
  renderRanking(){
    const el=document.getElementById('f-ranking'); if(!el) return;
    if(!this.revealed){ el.innerHTML=''; return; }
    const hx=cc=>'#'+((cc>>>0)&0xffffff).toString(16).padStart(6,'0');
    const conc=state.marketConcentration||0;
    const concTxt=conc>0.45?'quasi-monopole — profits forts, État et ouvriers réagissent':conc>0.2?'oligopole — le marché se referme':'concurrence vive — pression permanente sur les prix';
    el.innerHTML='<div class="fkh">Classement industriel</div>'+this.ranking().map((r,i)=>
      `<div class="row${r.me?' me':''}"><span class="dot" style="background:${hx(r.couleur)};${r.vivant?'':'opacity:.25'}"></span>`+
      `<span class="nm">${i+1}. ${r.nom}${r.vivant?'':' †'}</span><span class="st">${r.stage}</span><span class="pt">${pct(r.part)}</span></div>`).join('')+
      `<div class="conc">Concentration : ${pct(conc)} — ${concTxt}</div>`;
  }
};
const STAGE_NAME={1:'Atelier',2:'Manufacture',3:'Grande industrie'};
/* v50 — Le quartier du joueur. Jusqu'ici, Brandt, Verrié et Halage avaient
   halo de couleur et enseigne — pas toi. Or « le tien » existe : l'Usine et
   l'Entrepôt sont TON capital fixe (la banque, les marchés et l'État sont à
   tous). On le marque donc dans le même langage visuel : halo or, enseigne,
   et tes logements ouvriers près de l'usine quand l'effectif grandit. */
const PlayerDistrict={
  marked:false,
  mark(){
    if(this.marked) return; this.marked=true;
    for(const zn of ['Usine','Entrepôt']){
      const g=zoneGroups[zn]; if(!g) continue;
      const ring=new THREE.Mesh(new THREE.RingGeometry(9.6,10.4,44),
        new THREE.MeshBasicMaterial({color:COL.or,transparent:true,opacity:.45,side:THREE.DoubleSide}));
      ring.rotation.x=-Math.PI/2; ring.position.y=0.045; g.add(ring);
    }
    const us=zoneGroups['Usine'];
    if(us){ const lab=makeLabel('⚒ Ton entreprise'); lab.scale.set(8,1.6,1); lab.position.set(0,11.5,0); us.add(lab); }
  },
  /* logements ouvriers du joueur : même règle que les firmes (1 maison / 4 ouvriers) */
  refreshHousing(){
    const us=zoneGroups['Usine']; if(!us||!this.marked) return;
    clearLayer(us,'phouses');
    const n=Math.min(3,Math.floor((state.travailleurs||0)/4));
    for(let i=0;i<n;i++){ const h=createWorkerHouse(3.0,COL.froid);
      h.position.set(-10+i*3.4,0,-7.5); h.rotation.y=0.15*(i-1); tagLayer(h,'phouses'); us.add(h); }
  }
};

/* v50 — LA VILLE SE REJOINT.
   Le niveau de ville n'est plus indexé sur le seul joueur : il dérive du
   développement COLLECTIF (ton âge + les âges des firmes vivantes). À mesure
   qu'il monte, rues, réverbères, habitations et clôtures comblent l'espace
   entre les quartiers — les secteurs se rejoignent, la ville se fait.
     niveau 1 : réverbères le long des axes entre quartiers ;
     niveau 2 : + maisons ouvrières dans les interstices ;
     niveau 3 : + îlots denses et cheminées : les secteurs fusionnent. */
const CityGrowth={
  level:0, group:null,
  collective(){
    const firms=(state.competitors||[]).filter(c=>c.vivant);
    return (state.age||1) + firms.reduce((a,c)=>a+(c.stage||1),0);   // 4 au départ (1+1+1+1)
  },
  targetLevel(){ const c=this.collective(); return c>=9?3:c>=7?2:c>=5?1:0; },
  /* v52 — la ville-rue se densifie comme une vraie ville linéaire :
       niv. 1 : réverbères le long de la GRAND-RUE ;
       niv. 2 : + ruelle vers le quartier ouvrier et CONTRE-ALLÉE SUD (entre les
                parcelles industrielles et les logements) qui se peuplent de maisons ;
       niv. 3 : + contre-allée nord (derrière les institutions) — le tissu se ferme. */
  segments(){
    return [
      {a:{x:-108,z:0},  b:{x:96,z:0},   min:1},   // grand-rue
      {a:{x:0,z:14},    b:{x:0,z:50},   min:2},   // ruelle vers le quartier ouvrier
      {a:{x:-72,z:46},  b:{x:96,z:46},  min:2},   // contre-allée sud (entre usines et logements)
      {a:{x:-90,z:-42}, b:{x:30,z:-42}, min:3},   // contre-allée nord (derrière banque/marchés)
    ];
  },
  nearZone(x,z){ return zones.some(zz=>((zz.pos.x-x)**2+(zz.pos.z-z)**2) < 13*13); },
  /* distance point->segment, pour épargner la ligne dorée du circuit */
  _segDist(px,pz,a,b){
    const dx=b.x-a.x, dz=b.z-a.z, L2=dx*dx+dz*dz||1;
    const k=Math.max(0,Math.min(1,((px-a.x)*dx+(pz-a.z)*dz)/L2));
    return Math.hypot(px-(a.x+dx*k), pz-(a.z+dz*k));
  },
  nearCircuitLine(x,z){
    if(typeof CIRCUIT==='undefined') return false;
    const pts=CIRCUIT.map(c=>{const zz=zones.find(q=>q.name===c.zone); return zz?{x:zz.pos.x,z:zz.pos.z}:null;}).filter(Boolean);
    for(let i=0;i<pts.length;i++){ if(this._segDist(x,z,pts[i],pts[(i+1)%pts.length])<11) return true; }
    return false;
  },
  rebuild(){
    if(this.group&&scene) scene.remove(this.group);
    this.group=new THREE.Group(); this.group.name='CityGrowth'; scene.add(this.group);
    if(this.level<=0) return;
    let total=0; const TOTAL_MAX=120;          // plafond global de performance
    const den=(typeof dDen==='function'?dDen():0.65);
    let seed=7;
    const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };  // déterministe : la ville ne « saute » pas
    for(const seg of this.segments()){
      if(this.level<seg.min) continue;
      const a=seg.a, b=seg.b;
      // densité croissante : niveau 1 -> rues éclairées, niveau 3 -> tissu urbain serré
      const L=Math.hypot(b.x-a.x,b.z-a.z), n=Math.min(22,Math.max(4,Math.round(L/(12-2*this.level)*den)));  // plafonné : la densité reste sobre
      const ux=(b.x-a.x)/L, uz=(b.z-a.z)/L, nx=-uz, nz=ux;          // direction + normale : la rue a deux côtés
      for(let i=1;i<n;i++){
        const k=i/n;
        // une rue a deux côtés : on pose de part et d'autre de l'axe (le centre reste roulable)
        const sides=this.level>=2?[-1,1]:[(i%2)?1:-1];
        for(const sgn of sides){
          const off=4.5+rnd()*3.5;
          const x=a.x+(b.x-a.x)*k+nx*off*sgn+(rnd()-0.5)*3;
          const z=a.z+(b.z-a.z)*k+nz*off*sgn+(rnd()-0.5)*3;
          if(Math.abs(x)>HALF-6||Math.abs(z)>HALF-6||this.nearZone(x,z)||this.nearCircuitLine(x,z)) continue;
          const r=rnd();
          let obj=null;
          if(this.level>=3 && r<0.25){ obj=createWorkerHouse(3.4,0x8b7d63); const ch=createChimney(5); ch.position.set(1.2,0,0); obj.add(ch); }
          else if(this.level>=2 && r<0.5){ obj=createWorkerHouse(2.9,COL.froid); }
          else if(r<0.78){ obj=createLampPost(); }
          else { obj=createFenceSegment(3.5); }
          obj.position.set(x,0,z);
          obj.rotation.y=Math.atan2(ux,uz)+ (r<0.78?0:(rnd()-0.5)*0.6);   // aligné sur la rue
          this.group.add(obj);
          if(++total>=TOTAL_MAX) return;
        }
      }
    }
  },
  /* v54 — à l'ère de la grande industrie, une voie ferrée longe la rue,
     de la ceinture des usines jusqu'au port : les marchandises prennent le rail. */
  buildRails(){
    if(this._rails) return; this._rails=true;
    const rg=new THREE.Group(); rg.name='CityRails'; scene.add(rg);
    for(let x=-62;x<=92;x+=12){ const r=createRailSegment(12); r.rotation.y=Math.PI/2; r.position.set(x+6,0,15.5); rg.add(r); }
    this._wagon=createWagon();
    for(let i=0;i<2;i++){ const c=createCrate(1.1,i?0x8a6b49:COL.or); c.position.set(0,2.2,-1+i*2); this._wagon.add(c); }
    this._wagon.rotation.y=Math.PI/2; this._wagon.position.set(-58,0.1,15.5); rg.add(this._wagon);
    this._wagonDir=1;
    addHistoricalEvent('age','Une voie ferrée relie les usines au port : les marchandises prennent le rail.');
    pushLog('Ville','Le rail est posé le long de la grand-rue — du quartier des usines jusqu’au port.','plain');
  },
  updateRails(dt){
    if(!this._rails||!this._wagon) return;
    const w=this._wagon; w.position.x+=this._wagonDir*dt*7;
    if(w.position.x>90){ this._wagonDir=-1; } if(w.position.x<-58){ this._wagonDir=1; }
  },
  update(){
    const t=this.targetLevel();
    if(t>=3) this.buildRails();
    if(t===this.level) return;
    this.level=t; this.rebuild();
    const msg=[null,
      'La ville se rejoint : des rues éclairées relient vos quartiers.',
      'Entre les ateliers, des maisons ouvrières comblent les vides : la ville absorbe les campagnes.',
      'Les secteurs fusionnent en tissu urbain continu : la ville industrielle est l’œuvre de tous les capitaux.'][t];
    if(msg){ addHistoricalEvent('age',msg); pushLog('Ville',msg,'plain'); if(typeof flashTimer!=='undefined') flashTimer=0.5; }
  }
};
/* =====================================================================
   v65 — L'HORIZON (direction artistique « Charbon et lumière »).
   Le monde ne s'arrête plus au cadre : trois couronnes de silhouettes
   l'entourent et fondent dans la brume (bandes de profondeur, façon
   Jusant). Et ces silhouettes RACONTENT : collines et moulins à l'ouest
   et au sud (la campagne continue), skylines industrielles hérissées de
   cheminées au nord et à l'est (D'AUTRES VILLES, d'autres capitaux —
   le monde du jeu n'est qu'une formation sociale parmi d'autres).
   Matériaux soumis au brouillard : la profondeur se peint toute seule.
   ===================================================================== */
/* =====================================================================
   M2 — L'HORIZON (refonte « Veille du Capital »).
   Toutes les masses beiges/pyramides/collines de la version précédente
   sont remplacées par une SKYLINE INDUSTRIELLE en 2 couches de profondeur :
     couche proche (~210) : silhouettes hautes (façades, toits variés, cheminées
                            fines), densité forte côté ouest = centre financier.
     couche lointaine (~280) : silhouettes plus basses, fondues plus avant.
   Matériau 0x232a3a, fog:true → le brouillard sculpte la profondeur.
   Géographie de classe : fenêtres émissives gasLight 0xffb45e éparses,
   denses à l'OUEST (cœur financier), rares à l'EST (faubourgs noirs).
   4-5 colonnes de fumée animées (sprites empilés) sur les cheminées lointaines.
   ===================================================================== */
const distantGlows=[];                                  // fenêtres : DayCycle les rallume la nuit
const SMOKE_COLUMNS=[];                                 // pour le sélecteur qualité

function buildHorizon(){
  let seed=99; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
  // M-Peaufinage/A : 3 matières (proche, lointaine, très lointaine) plus
  //   claires à mesure qu'on s'éloigne — donne la PROFONDEUR ATMOSPHÉRIQUE
  //   même avant que le fog ne fasse son travail.
  const mat_near = new THREE.MeshStandardMaterial({color:0x232a3a, roughness:1, metalness:0, flatShading:true, fog:true});
  const mat_mid  = new THREE.MeshStandardMaterial({color:0x363d4f, roughness:1, metalness:0, flatShading:true, fog:true});
  const mat_far  = new THREE.MeshStandardMaterial({color:0x4a5266, roughness:1, metalness:0, flatShading:true, fog:true});
  const sky_chimney=new THREE.MeshStandardMaterial({
    color:0x1c222e, roughness:1, metalness:0, flatShading:true, fog:true,
  });
  const sky_chimney_far=new THREE.MeshStandardMaterial({
    color:0x3a4256, roughness:1, metalness:0, flatShading:true, fog:true,
  });
  // matière dôme/ornement clair (financier ouest)
  const mat_dome_near = new THREE.MeshStandardMaterial({color:0x4a4030, roughness:0.9, metalness:0.1, flatShading:true, fog:true});

  // densité fenêtres : ouest (-X) = riche, est (+X) = pauvre/noir
  const windowDensity=(x,z)=>{
    const angle=Math.atan2(z,x);                        // 0 = est, π = ouest
    const westness=(Math.cos(angle)*-0.5)+0.5;          // 0 est → 1 ouest
    return 0.10 + 0.55*westness*westness;
  };

  // ------------- VARIANTES DE TOIT -------------------
  function _roofPlat(parent, w, h, depth, mat){
    const cw=w*(0.95+rnd()*0.1), cd=depth*1.10, ch=0.6+rnd()*0.8;
    const cor=new THREE.Mesh(new THREE.BoxGeometry(cw,ch,cd), mat);
    cor.position.y=h+ch/2; parent.add(cor);
  }
  function _roofPignon(parent, w, h, depth, mat){
    const ph=1.4+rnd()*1.8;
    const peak=new THREE.Mesh(new THREE.ConeGeometry(w*0.55, ph, 4), mat);
    peak.rotation.y=Math.PI/4; peak.position.y=h+ph/2; parent.add(peak);
  }
  function _roofMansarde(parent, w, h, depth, mat){
    // 2 boxes superposés trapézoïdaux (haut plus petit que bas) → toit cassé
    const h1=0.7+rnd()*0.5;
    const lower=new THREE.Mesh(new THREE.BoxGeometry(w*0.95, h1, depth*1.05), mat);
    lower.position.y=h+h1/2; parent.add(lower);
    const h2=0.5+rnd()*0.4;
    const upper=new THREE.Mesh(new THREE.BoxGeometry(w*0.70, h2, depth*0.85), mat);
    upper.position.y=h+h1+h2/2; parent.add(upper);
  }
  function _roofDome(parent, w, h, depth, matDome){
    // demi-sphère sur tambour (institutionnel — clocher d'église, dôme)
    const drumH=0.5+rnd()*0.4;
    const drum=new THREE.Mesh(new THREE.CylinderGeometry(w*0.30, w*0.32, drumH, 10), matDome);
    drum.position.y=h+drumH/2; parent.add(drum);
    const r=w*0.30;
    const dome=new THREE.Mesh(new THREE.SphereGeometry(r, 10, 6, 0, Math.PI*2, 0, Math.PI*0.5), matDome);
    dome.position.y=h+drumH; parent.add(dome);
    // pointe (lanterneau)
    const tipH=0.8+rnd()*0.6;
    const tip=new THREE.Mesh(new THREE.ConeGeometry(0.12, tipH, 6), matDome);
    tip.position.y=h+drumH+r+tipH/2; parent.add(tip);
  }
  function _roofClocher(parent, w, h, depth, mat){
    // tour-clocher : box étroite + flèche pointue
    const tH=2+rnd()*2;
    const tower=new THREE.Mesh(new THREE.BoxGeometry(w*0.45, tH, depth*0.45), mat);
    tower.position.y=h+tH/2; parent.add(tower);
    const sH=2.5+rnd()*2.5;
    const spire=new THREE.Mesh(new THREE.ConeGeometry(w*0.22, sH, 6), mat);
    spire.position.y=h+tH+sH/2; parent.add(spire);
  }

  // ------------- FAÇADE complète -----------------------
  const buildFacade=(parent, w, hMax, depth, matBody, matChim, matDome)=>{
    const h=hMax*(0.5+rnd()*0.5);                 // taille TRÈS variable
    const main=new THREE.Mesh(new THREE.BoxGeometry(w,h,depth), matBody);
    main.position.y=h/2; parent.add(main);

    // Variantes de toit : plat 35 % · pignon 25 % · mansarde 18 % ·
    //   dôme 12 % (institutionnel) · clocher 10 % (rare, haut).
    const r=rnd();
    if(r<0.35)      _roofPlat    (parent, w, h, depth, matBody);
    else if(r<0.60) _roofPignon  (parent, w, h, depth, matBody);
    else if(r<0.78) _roofMansarde(parent, w, h, depth, matBody);
    else if(r<0.90) _roofDome    (parent, w, h, depth, matDome);
    else            _roofClocher (parent, w, h, depth, matBody);

    // cheminées (densité plus forte côté industriel = est/nord-est)
    const angle=Math.atan2(parent.position.z, parent.position.x);
    const eastness=(Math.cos(angle)*0.5)+0.5;
    const nCh = (rnd() < 0.35 + eastness*0.40) ? (1 + (rnd()<0.4 ? 1 : 0)) : 0;
    for(let i=0;i<nCh;i++){
      const chH = 4+rnd()*8;
      const ch=new THREE.Mesh(new THREE.CylinderGeometry(0.45+rnd()*0.25, 0.5+rnd()*0.3, chH, 6), matChim);
      ch.position.set((rnd()-0.5)*w*0.7, h+chH/2, (rnd()-0.5)*depth*0.4);
      parent.add(ch);
      ch.userData.smokeAnchor=true;
    }

    // fenêtres émissives : densité par x/z mondial + irrégularité par window.
    const dens=windowDensity(parent.position.x, parent.position.z);
    const targetN=Math.round(8*dens);
    for(let k=0;k<targetN;k++){
      const wx=(rnd()-0.5)*w*0.7;
      const wy=2+rnd()*(h-4);
      const fw=new THREE.Mesh(new THREE.PlaneGeometry(0.55+rnd()*0.5, 0.7+rnd()*0.5),
        new THREE.MeshStandardMaterial({
          color:0x1c2026, emissive:COLORSCRIPT.gasLight, emissiveIntensity:0.0,
          fog:true,
        }));
      fw.position.set(wx, wy, -depth/2-0.04);
      fw.rotation.y=Math.PI;
      parent.add(fw);
      // M-Peaufinage/A : facteur de brillance + chance d'allumage + phase
      //   de scintillement, stockés sur le material pour updateWindowGlow.
      const mm = fw.material;
      mm.userData = {
        glowFactor: 0.55 + rnd()*0.95,      // 0.55..1.50
        litChance:  rnd() < 0.78,           // 78 % des fenêtres s'allument la nuit
        flickerPh:  rnd() * 6.2831853,
      };
      distantGlows.push(mm);
    }
  };

  // ------------- GRUE/ÉCHAFAUDAGE industriel ----------
  function buildCrane(x, z, mat, big){
    const g=new THREE.Group(); g.position.set(x, 0, z);
    g.rotation.y=Math.atan2(x, z);
    const H = big ? (16+rnd()*6) : (10+rnd()*4);
    // mât vertical (treillis simulé par 2 montants + croisillons fins)
    const W = big ? 1.2 : 0.7;
    for(const sx of [-1,1]){
      const m=new THREE.Mesh(new THREE.BoxGeometry(0.18, H, 0.18), mat);
      m.position.set(sx*W*0.5, H/2, 0); g.add(m);
    }
    // croisillons X (3-4 paires)
    const Nx = big ? 4 : 3;
    for(let i=0;i<Nx;i++){
      const y = H*(0.18 + i*(0.65/Nx));
      const cross=new THREE.Mesh(new THREE.BoxGeometry(W*1.2, 0.10, 0.10), mat);
      cross.position.y=y; cross.rotation.z=(i%2 ? 0.5 : -0.5);
      g.add(cross);
    }
    // potence horizontale en haut
    const armLen = big ? (8+rnd()*4) : (5+rnd()*2);
    const arm=new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.20, 0.20), mat);
    arm.position.set(armLen/2-W*0.5, H-0.3, 0); g.add(arm);
    // câble vertical (un peu plus loin)
    const cable=new THREE.Mesh(new THREE.BoxGeometry(0.05, H*0.6, 0.05), mat);
    cable.position.set(armLen*0.75-W*0.5, H-H*0.30, 0); g.add(cable);
    scene.add(g);
  }

  // ------------- COUCHES de SKYLINE ---------------------
  // construit une couche de skyline sur un cercle de rayon R.
  //   M13b — côté EAU (x > 105, dans la fourchette z de l'eau) : aucune
  //   silhouette. L'horizon doit se perdre dans la brume au-dessus de
  //   l'eau. Les couches terre (ouest/nord/sud) restent intactes.
  const buildLayer=(R, count, hMax, depth, minW, maxW, matBody, matChim, matDome)=>{
    for(let i=0;i<count;i++){
      const a=(i/count)*Math.PI*2 + (rnd()-0.5)*0.1;
      const x=Math.sin(a)*R+(rnd()-0.5)*10;
      const z=Math.cos(a)*R+(rnd()-0.5)*10;
      // côté eau : pas de skyline.
      if(x > 105 && z > -210 && z < 210) continue;
      const g=new THREE.Group();
      g.position.set(x,0,z);
      g.rotation.y=Math.atan2(x,z);
      const n=2+Math.floor(rnd()*3);
      for(let j=0;j<n;j++){
        const sub=new THREE.Group();
        sub.position.x=(j-(n-1)/2)*(maxW*0.95);
        const w=minW+rnd()*(maxW-minW);
        buildFacade(sub, w, hMax, depth, matBody, matChim, matDome);
        g.add(sub);
      }
      scene.add(g);
    }
  };

  // M-Peaufinage/A : 3 COUCHES de profondeur. La plus lointaine (R=250)
  //   se fond presque dans le fog (matériau quasi-fog), donne la sensation
  //   d'horizon profond sans excéder le far du fog (260).
  buildLayer(195, 18, 24, 7, 5, 9, mat_near, sky_chimney, mat_dome_near);   // proche : variée, haute, contrastée
  buildLayer(225, 12, 16, 6, 4, 7, mat_mid,  sky_chimney,     mat_mid);     // intermédiaire
  buildLayer(250, 14, 12, 5, 4, 6, mat_far,  sky_chimney_far, mat_far);     // lointaine : claire, fondue dans le fog

  // Quelques grues/échafaudages industriels (silhouettes nettes — rappel
  //   du caractère industriel des autres villes). Placées sur le côté
  //   TERRE uniquement (ouest/nord-ouest). Côté eau : aucune silhouette
  //   industrielle — l'horizon reste vide jusqu'à la brume (M13b).
  const craneSpots = [
    [-160, 110], [ 80, 180], [-90, 175],
  ];
  for(let i=0;i<craneSpots.length;i++){
    buildCrane(craneSpots[i][0], craneSpots[i][1], mat_mid, i<2);
  }

  // 4-5 colonnes de fumée sur cheminées lointaines.
  // On choisit des ancres parmi les cheminées posées + parmi les couches.
  const anchors=[];
  scene.traverse(o=>{ if(o.userData && o.userData.smokeAnchor) anchors.push(o); });
  // tri par distance pour préférer les colonnes "lointaines"
  anchors.sort((a,b)=>{
    const pa=new THREE.Vector3(), pb=new THREE.Vector3(); a.getWorldPosition(pa); b.getWorldPosition(pb);
    return (pb.x*pb.x+pb.z*pb.z)-(pa.x*pa.x+pa.z*pa.z);
  });
  const NCols = Math.min(5, anchors.length);
  for(let i=0;i<NCols;i++){
    const a=anchors[Math.floor(i*anchors.length/NCols)];
    const wp=new THREE.Vector3(); a.getWorldPosition(wp);
    buildSmokeColumn(wp.x, wp.y+2, wp.z);
  }
}

/* buildSmokeColumn — 5 sprites empilés qui montent, se dilatent, s'estompent.
   Dérive vers l'est (vent d'ouest comme PuffTrains). Pour la skyline lointaine. */
function _smokeTexture(){
  if(_smokeTexture._cached) return _smokeTexture._cached;
  const c=document.createElement('canvas'); c.width=c.height=128;
  const x=c.getContext('2d');
  const g=x.createRadialGradient(64,64,2,64,64,62);
  g.addColorStop(0,'rgba(220,210,200,0.65)');
  g.addColorStop(0.5,'rgba(170,158,148,0.30)');
  g.addColorStop(1,'rgba(120,108,100,0)');
  x.fillStyle=g; x.fillRect(0,0,128,128);
  return _smokeTexture._cached=new THREE.CanvasTexture(c);
}
function buildSmokeColumn(x, y0, z){
  const tex=_smokeTexture();
  const col={x, y0, z, puffs:[]};
  for(let i=0;i<5;i++){
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({
      map:tex, color:0x6a6660, transparent:true, opacity:0,
      depthWrite:false, fog:true,
    }));
    sp.scale.set(3.5, 3.5, 1);
    scene.add(sp);
    col.puffs.push({obj:sp, phase: i/5, age: i/5});
  }
  SMOKE_COLUMNS.push(col);
}
function updateSkySmoke(dt){
  if(!SMOKE_COLUMNS.length) return;
  for(const col of SMOKE_COLUMNS){
    for(const p of col.puffs){
      p.age += dt*0.18;                            // ~5.5 s par cycle
      if(p.age>=1) p.age-=1;
      const a=p.age;
      // monte de 0 à +18 m
      const y=col.y0 + a*18;
      // dérive vers l'est (+x)
      const dx=a*6;
      p.obj.position.set(col.x+dx, y, col.z);
      // se dilate
      const s=3.5 + a*5;
      p.obj.scale.set(s, s, 1);
      // s'estompe (in/out)
      const op=Math.sin(a*Math.PI)*0.45;
      p.obj.material.opacity=op;
    }
  }
}

/* =====================================================================
   M2 — ATMOSPHÈRE DORÉE.
   Sun bas-horizon ouest + halo additif (nourrit le bloom sans saturer) ;
   voile additif doré sur le quart ouest (opacité 0.12, 0xb08a5a) ; nuages
   canvas (10-14, 2 altitudes, dérive est ; tache 0x4a4252 / 0xd98a3d face soleil) ;
   3-4 godrays cônes additifs très diffus du soleil, oscillation lente.
   Tout est sprite/plan transparent → coût frame < 3 ms.
   Position d'ancrage : suit la caméra (toujours visible côté ouest).
   ===================================================================== */
const SkyAtmo = {
  ready:false,
  clouds:[],
  veil:null,
  godrays:[],
  // M7-astres — soleil par COUCHES (du loin au près) :
  //   halo atmosphérique → aigrettes → couronne → cœur
  sunHalo:null, sunRays:[], sunCorona:null, sunCore:null,
  // lune : disque texturé (mers + cratères + phase) + halo froid.
  moonDisk:null, moonHalo:null,
  build(){
    if(this.ready) return; this.ready=true;

    // 1) HALO ATMOSPHÉRIQUE LARGE (rayon 4-5× le cœur) — donne l'impression
    //    de chaleur diffuse qui se fond dans le ciel.
    const haloTex=this._sunHaloTex();
    this.sunHalo=new THREE.Sprite(new THREE.SpriteMaterial({
      map:haloTex, color:0xffd98a, transparent:true, opacity:0.0,
      depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
    }));
    this.sunHalo.scale.set(140, 140, 1);
    this.sunHalo.renderOrder=-3;
    scene.add(this.sunHalo);

    // 2) AIGRETTES (rais fins) — 6 rais à 60° d'écart. Sprite ancré à
    //    sa BASE (center.y=0) pour qu'il s'étire VERS L'EXTÉRIEUR depuis
    //    le centre du soleil. material.rotation oriente chaque rai.
    const aigTex=this._sunAigretteTex();
    for(let i=0;i<6;i++){
      const ray=new THREE.Sprite(new THREE.SpriteMaterial({
        map:aigTex, color:0xffd9a4, transparent:true, opacity:0.0,
        depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
      }));
      ray.center.set(0.5, 0.0);                  // anchored at bottom
      ray.material.rotation=(i/6)*Math.PI*2;
      ray.scale.set(10, 60, 1);
      ray.renderOrder=-2;
      scene.add(ray);
      this.sunRays.push(ray);
    }

    // 3) COURONNE / PHOTOSPHÈRE — anneau de transition cœur → halo.
    const corTex=this._sunCoronaTex();
    this.sunCorona=new THREE.Sprite(new THREE.SpriteMaterial({
      map:corTex, color:0xffc88a, transparent:true, opacity:0.0,
      depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
    }));
    this.sunCorona.scale.set(42, 42, 1);
    this.sunCorona.renderOrder=-1;
    scene.add(this.sunCorona);

    // 4) CŒUR — disque vif aux bords irréguliers. Le plus brillant ; peut
    //    fleurir au bloom, mais les couches en-dessous restent lisibles.
    const coreTex=this._sunCoreTex();
    this.sunCore=new THREE.Sprite(new THREE.SpriteMaterial({
      map:coreTex, color:0xfff2d0, transparent:true, opacity:1.0,
      depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
    }));
    this.sunCore.scale.set(22, 22, 1);
    this.sunCore.renderOrder=0;
    scene.add(this.sunCore);

    // ----- LUNE : disque texturé qui BRILLE FRANCHEMENT en blanc-argent.
    // M7-astres-bis : la lune est une vraie source. Couches :
    //   halo extérieur large (×4) → halo intérieur dense (×2) → disque texturé
    //   couleur 0xffffff pure. Toutes additives — le bloom fait le reste.
    // La texture (mers, cratères, phase) module la luminosité ajoutée :
    //   bright = brillant qui fleurit, mers = nuances perceptibles,
    //   terminateur = ombre quasi-noire.
    const moonTex=this._moonDiskTex();
    this.moonDisk=new THREE.Sprite(new THREE.SpriteMaterial({
      map:moonTex, color:0xffffff, transparent:true, opacity:0.0,
      depthWrite:false, fog:false,
      blending:THREE.AdditiveBlending,
    }));
    this.moonDisk.scale.set(22, 22, 1);
    this.moonDisk.renderOrder=0;
    scene.add(this.moonDisk);
    // Halo INTÉRIEUR — dense, blanc-bleu lumineux (nouveau pour M7-astres-ter).
    const moonInnerHaloTex=this._moonHaloTex();
    this.moonInnerHalo=new THREE.Sprite(new THREE.SpriteMaterial({
      map:moonInnerHaloTex, color:0xe8efff, transparent:true, opacity:0.0,
      depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
    }));
    this.moonInnerHalo.scale.set(46, 46, 1);
    this.moonInnerHalo.renderOrder=-1;
    scene.add(this.moonInnerHalo);
    // Halo EXTÉRIEUR — large, plus diffus, blanc-bleu froid.
    const moonHaloTex=this._moonHaloTex();
    this.moonHalo=new THREE.Sprite(new THREE.SpriteMaterial({
      map:moonHaloTex, color:0xd0dcff, transparent:true, opacity:0.0,
      depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
    }));
    this.moonHalo.scale.set(105, 105, 1);
    this.moonHalo.renderOrder=-2;
    scene.add(this.moonHalo);

    // ----- voile doré : grand plan additif côté ouest -----
    // Quad ancré sur le dôme — rotation Y suit la position du soleil.
    const veilTex=this._veilTex();
    this.veil=new THREE.Mesh(new THREE.PlaneGeometry(280, 160),
      new THREE.MeshBasicMaterial({
        map:veilTex, color:0xb08a5a, transparent:true, opacity:0.12,
        depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
        side:THREE.DoubleSide,
      }));
    this.veil.renderOrder=-1;
    scene.add(this.veil);

    // ----- godrays : 3 cônes additifs très diffus -----
    const rayTex=this._rayTex();
    for(let i=0;i<3;i++){
      const ray=new THREE.Mesh(new THREE.PlaneGeometry(60, 220),
        new THREE.MeshBasicMaterial({
          map:rayTex, color:0xffd9a0, transparent:true, opacity:0.0,
          depthWrite:false, fog:false, blending:THREE.AdditiveBlending,
          side:THREE.DoubleSide,
        }));
      ray.userData.baseOp=[0.10,0.08,0.06][i];
      ray.userData.tilt=(i-1)*0.18;
      ray.renderOrder=-1;
      scene.add(ray);
      this.godrays.push(ray);
    }

    // ----- nuages : 12 sprites, 2 altitudes -----
    const cloudA=this._cloudTex(0xd98a3d);   // côté soleil : ourlet doré
    const cloudB=this._cloudTex(0x4a4252);   // côté ombre : nuage sombre
    for(let i=0;i<12;i++){
      const altHigh = i%3 === 0;
      const map = (i%2===0) ? cloudA : cloudB;
      const m=new THREE.Sprite(new THREE.SpriteMaterial({
        map, transparent:true, opacity:0.0,
        depthWrite:false, fog:true,
      }));
      const s=22+Math.random()*22;
      m.scale.set(s, s*0.55, 1);
      m.userData={
        baseY: altHigh? 95 : 62,
        radius: 180+Math.random()*40,
        angle: Math.random()*Math.PI*2,
        drift: 0.012+Math.random()*0.014,
        baseOp: 0.45+Math.random()*0.20,
      };
      scene.add(m);
      this.clouds.push(m);
    }
  },
  _sunDiskTex(){
    // (legacy — non utilisé, gardé pour rétro-compat)
    const c=document.createElement('canvas'); c.width=c.height=128; const x=c.getContext('2d');
    const g=x.createRadialGradient(64,64,4,64,64,62);
    g.addColorStop(0,   'rgba(255,238,196,1.0)');
    g.addColorStop(0.45,'rgba(255,210,140,0.85)');
    g.addColorStop(0.75,'rgba(255,180,90,0.30)');
    g.addColorStop(1,   'rgba(255,170,70,0)');
    x.fillStyle=g; x.fillRect(0,0,128,128);
    return new THREE.CanvasTexture(c);
  },
  /* M7-astres — CŒUR du soleil. Disque vif aux bords subtilement irréguliers
     (pas un cercle parfait). Couleur appliquée par material.color depuis
     SunState.sunColor — le canvas garde le bord et le dégradé seulement. */
  _sunCoreTex(){
    const c=document.createElement('canvas'); c.width=c.height=256;
    const x=c.getContext('2d');
    x.clearRect(0,0,256,256);
    // bord irrégulier — 64 segments avec micro-bruit
    const N=64;
    const pts=[];
    for(let i=0;i<N;i++){
      const a=(i/N)*Math.PI*2;
      const r = 98 + Math.sin(a*7 + 0.3) * 1.6 + Math.sin(a*11 - 0.7) * 0.9 + Math.sin(a*5) * 1.3;
      pts.push({x:128+Math.cos(a)*r, y:128+Math.sin(a)*r});
    }
    // dégradé radial brûlant
    const g=x.createRadialGradient(128,128,2,128,128,110);
    g.addColorStop(0,    'rgba(255,255,238,1.0)');
    g.addColorStop(0.40, 'rgba(255,242,200,1.0)');
    g.addColorStop(0.80, 'rgba(255,210,150,0.95)');
    g.addColorStop(1.0,  'rgba(255,180,100,0.0)');
    x.fillStyle=g;
    x.beginPath();
    x.moveTo(pts[0].x, pts[0].y);
    for(let i=1;i<N;i++) x.lineTo(pts[i].x, pts[i].y);
    x.closePath();
    x.fill();
    return new THREE.CanvasTexture(c);
  },
  /* M7-astres — COURONNE solaire (anneau de transition cœur ↔ halo). */
  _sunCoronaTex(){
    const c=document.createElement('canvas'); c.width=c.height=256;
    const x=c.getContext('2d');
    x.clearRect(0,0,256,256);
    const g=x.createRadialGradient(128,128,30,128,128,124);
    g.addColorStop(0.0,  'rgba(255,200,120,0.0)');
    g.addColorStop(0.35, 'rgba(255,200,130,0.55)');
    g.addColorStop(0.60, 'rgba(255,180,110,0.60)');
    g.addColorStop(0.85, 'rgba(255,160,90,0.25)');
    g.addColorStop(1.0,  'rgba(255,150,80,0)');
    x.fillStyle=g; x.fillRect(0,0,256,256);
    return new THREE.CanvasTexture(c);
  },
  /* M7-astres — AIGRETTES (rais fins) discrètes, marquées à l'horizon. */
  _sunAigretteTex(){
    const c=document.createElement('canvas'); c.width=48; c.height=192;
    const x=c.getContext('2d');
    x.clearRect(0,0,48,192);
    // dégradé linéaire bottom→top (bas = près du soleil)
    const g=x.createLinearGradient(0,192,0,0);
    g.addColorStop(0,   'rgba(255,222,170,0.85)');
    g.addColorStop(0.25,'rgba(255,200,140,0.55)');
    g.addColorStop(0.65,'rgba(255,180,110,0.25)');
    g.addColorStop(1,   'rgba(255,170,90,0)');
    x.fillStyle=g; x.fillRect(16, 0, 16, 192);
    // adoucir les bords (mask radial)
    const mask=x.createRadialGradient(24, 96, 4, 24, 96, 16);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    x.globalCompositeOperation='destination-in';
    x.fillStyle=mask; x.fillRect(0,0,48,192);
    return new THREE.CanvasTexture(c);
  },
  _sunHaloTex(){
    const c=document.createElement('canvas'); c.width=c.height=256; const x=c.getContext('2d');
    const g=x.createRadialGradient(128,128,8,128,128,128);
    g.addColorStop(0,   'rgba(255,224,170,0.55)');
    g.addColorStop(0.5, 'rgba(255,200,130,0.12)');
    g.addColorStop(1,   'rgba(255,180,90,0)');
    x.fillStyle=g; x.fillRect(0,0,256,256);
    return new THREE.CanvasTexture(c);
  },
  /* M7-astres — LUNE détaillée : surface gris-bleu froid + MERS lunaires
     + CRATÈRES (cercles + ombre) + PHASE gibbeuse (terminateur côté droit)
     + LUMIÈRE CENDRÉE (earthshine) très subtile côté ombre. */
  _moonDiskTex(){
    const c=document.createElement('canvas'); c.width=c.height=256;
    const x=c.getContext('2d');
    x.clearRect(0,0,256,256);
    // Clip au disque circulaire
    x.save();
    x.beginPath();
    x.arc(128, 128, 108, 0, Math.PI*2);
    x.clip();
    // BASE : gris-bleu froid, plus chaud côté nord-ouest (éclairement)
    const baseGrad=x.createRadialGradient(95, 95, 8, 128, 128, 132);
    baseGrad.addColorStop(0,   'rgba(228,232,240,1.0)');
    baseGrad.addColorStop(0.55,'rgba(196,202,216,1.0)');
    baseGrad.addColorStop(0.90,'rgba(156,164,184,0.95)');
    baseGrad.addColorStop(1,   'rgba(120,128,148,0.90)');
    x.fillStyle=baseGrad; x.fillRect(0,0,256,256);
    // grain de surface (regolith)
    for(let i=0;i<400;i++){
      const px=Math.random()*256, py=Math.random()*256;
      x.fillStyle=Math.random()<0.5?'rgba(168,174,190,0.25)':'rgba(220,224,232,0.15)';
      x.fillRect(px, py, 1+Math.random()*1.5, 1+Math.random()*1.2);
    }
    // MERS lunaires — taches sombres irrégulières (5 mares principales)
    const mares=[
      // [cx, cy, rx, ry, opacity]
      [88, 92, 30, 22, 0.40],     // Mare Imbrium (NW)
      [120, 110, 24, 20, 0.36],   // Mare Serenitatis (centre N)
      [142, 132, 22, 18, 0.38],   // Mare Tranquillitatis (centre E)
      [82, 152, 24, 26, 0.32],    // Mare Humorum (SW)
      [165, 100, 18, 14, 0.30],   // Mare Crisium (NE)
      [105, 175, 16, 14, 0.28],   // Mare Nubium (S)
    ];
    for(const [cx, cy, rx, ry, op] of mares){
      const g=x.createRadialGradient(cx, cy, 3, cx, cy, Math.max(rx, ry)*1.15);
      g.addColorStop(0, 'rgba(98,108,128,'+op+')');
      g.addColorStop(0.7, 'rgba(108,118,138,'+(op*0.5)+')');
      g.addColorStop(1, 'rgba(108,118,138,0)');
      x.fillStyle=g;
      x.save();
      x.translate(cx, cy);
      x.scale(rx/20, ry/20);
      x.beginPath(); x.arc(0,0,20,0,Math.PI*2); x.fill();
      x.restore();
    }
    // CRATÈRES — 14 cercles avec ombre portée subtile
    const craters=[
      [70, 70, 5], [92, 60, 4], [120, 70, 3], [150, 78, 4], [175, 88, 5],
      [85, 120, 3], [110, 145, 4], [148, 158, 3], [98, 175, 4], [128, 195, 5],
      [60, 145, 4], [175, 145, 3], [70, 185, 3], [165, 175, 4],
    ];
    for(const [cx, cy, r] of craters){
      // ring d'ombre (rebord du cratère)
      x.fillStyle='rgba(80,86,102,0.55)';
      x.beginPath(); x.arc(cx, cy, r+1, 0, Math.PI*2); x.fill();
      // intérieur clair (regolith exposé)
      const ig=x.createRadialGradient(cx-r*0.3, cy-r*0.3, 0, cx, cy, r);
      ig.addColorStop(0, 'rgba(232,236,244,0.85)');
      ig.addColorStop(1, 'rgba(168,176,192,0.65)');
      x.fillStyle=ig;
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI*2); x.fill();
      // pointe centrale (petit point blanc — pic central)
      if(r >= 4){
        x.fillStyle='rgba(248,250,254,0.55)';
        x.beginPath(); x.arc(cx, cy, 0.8, 0, Math.PI*2); x.fill();
      }
    }
    // PHASE GIBBEUSE : terminateur côté droit, ~25% en ombre
    // dégradé linéaire dur du clair au sombre vers la droite
    const phase=x.createLinearGradient(160, 0, 230, 0);
    phase.addColorStop(0,    'rgba(20,24,32,0)');
    phase.addColorStop(0.45, 'rgba(18,22,30,0.55)');
    phase.addColorStop(0.80, 'rgba(12,16,22,0.85)');
    phase.addColorStop(1,    'rgba(8,10,16,0.93)');
    x.fillStyle=phase; x.fillRect(160, 0, 96, 256);
    // LUMIÈRE CENDRÉE (earthshine) — très faible chaleur sur la zone sombre,
    // suggère que la Terre éclaire la face cachée
    const earth=x.createLinearGradient(180, 0, 240, 0);
    earth.addColorStop(0, 'rgba(80,70,100,0)');
    earth.addColorStop(1, 'rgba(110,90,120,0.08)');
    x.fillStyle=earth; x.fillRect(180, 0, 76, 256);
    x.restore();   // exit clip
    return new THREE.CanvasTexture(c);
  },
  _moonHaloTex(){
    const c=document.createElement('canvas'); c.width=c.height=256; const x=c.getContext('2d');
    const g=x.createRadialGradient(128,128,8,128,128,128);
    g.addColorStop(0,   'rgba(180,196,224,0.40)');
    g.addColorStop(0.5, 'rgba(148,170,210,0.08)');
    g.addColorStop(1,   'rgba(148,170,210,0)');
    x.fillStyle=g; x.fillRect(0,0,256,256);
    return new THREE.CanvasTexture(c);
  },
  _veilTex(){
    const c=document.createElement('canvas'); c.width=512; c.height=256; const x=c.getContext('2d');
    const g=x.createRadialGradient(256,170,40,256,170,260);
    g.addColorStop(0,   'rgba(255,220,180,0.55)');
    g.addColorStop(0.55,'rgba(220,170,110,0.20)');
    g.addColorStop(1,   'rgba(176,138,90,0)');
    x.fillStyle=g; x.fillRect(0,0,512,256);
    return new THREE.CanvasTexture(c);
  },
  _rayTex(){
    const c=document.createElement('canvas'); c.width=128; c.height=512; const x=c.getContext('2d');
    // bande verticale très douce, plus dense vers le haut (source soleil)
    const g=x.createLinearGradient(0,0,0,512);
    g.addColorStop(0,   'rgba(255,225,170,0.75)');
    g.addColorStop(0.4, 'rgba(255,210,150,0.30)');
    g.addColorStop(1,   'rgba(255,200,130,0)');
    x.fillStyle=g; x.fillRect(0,0,128,512);
    // pinceau latéral pour éviter une bande nette
    const gh=x.createRadialGradient(64,256,8,64,256,90);
    gh.addColorStop(0,'rgba(255,255,255,0.0)'); gh.addColorStop(1,'rgba(0,0,0,0.55)');
    x.globalCompositeOperation='destination-out';
    x.fillStyle=gh; x.fillRect(0,0,128,512);
    x.globalCompositeOperation='source-over';
    return new THREE.CanvasTexture(c);
  },
  _cloudTex(rimColor){
    const c=document.createElement('canvas'); c.width=256; c.height=128; const x=c.getContext('2d');
    // base sombre / floue
    for(let i=0;i<5;i++){
      const px=40+Math.random()*180, py=50+Math.random()*30, rr=30+Math.random()*40;
      const g=x.createRadialGradient(px,py,4,px,py,rr);
      g.addColorStop(0,'rgba(74,66,82,0.85)'); g.addColorStop(1,'rgba(74,66,82,0)');
      x.fillStyle=g; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
    }
    // ourlet (rim light) côté soleil — superposé en haut-droite
    const rim=`rgba(${(rimColor>>16)&0xff},${(rimColor>>8)&0xff},${rimColor&0xff},`;
    for(let i=0;i<3;i++){
      const px=140+Math.random()*80, py=40+Math.random()*20, rr=22+Math.random()*22;
      const g=x.createRadialGradient(px,py,2,px,py,rr);
      g.addColorStop(0, rim+'0.65)'); g.addColorStop(1, rim+'0)');
      x.fillStyle=g; x.beginPath(); x.arc(px,py,rr,0,Math.PI*2); x.fill();
    }
    return new THREE.CanvasTexture(c);
  },
  update(dt){
    if(!this.ready) return;
    // anchor : suit la caméra horizontalement → atmosphère toujours visible
    const cx = (typeof camera!=='undefined' && camera) ? camera.position.x : 0;
    const cz = (typeof camera!=='undefined' && camera) ? camera.position.z : 0;

    // M7-astres — positions monde depuis SunState (caméra-relative).
    const sx = SunState.sunDir.x * SUN_DISPLAY_R;
    const sy = Math.max(-50, SunState.sunDir.y * SUN_DISPLAY_R);
    const sz = SunState.sunDir.z * SUN_DISPLAY_R;
    const mx = SunState.moonDir.x * SUN_DISPLAY_R;
    const my = Math.max(-50, SunState.moonDir.y * SUN_DISPLAY_R);
    const mz = SunState.moonDir.z * SUN_DISPLAY_R;
    const sunY = SunState.sunDir.y;
    const moonY = SunState.moonDir.y;

    // ==================== SOLEIL — couches superposées ====================
    // « horizonness » : 0 au zénith, 1 quand soleil bas → pilote la teinte
    // rougie, le grossissement, l'aplatissement (réfraction), l'apparition
    // des aigrettes.
    const horizonness = Math.max(0, 1 - Math.max(0, sunY) * 3.5);
    const sunsetGrow  = 1.0 + horizonness * 0.55;        // soleil grossit au couchant
    const flattenY    = 1.0 - horizonness * 0.10;        // s'aplatit (réfraction)
    // teintes : blanc-chaud au zénith → ROUGE-SANG profond à l'horizon
    // (M7-astres-bis : soleil de crépuscule industriel chargé de fumée)
    const _cNoon       = SkyAtmo._cNoon       || (SkyAtmo._cNoon       = new THREE.Color(0xfff2d0));
    const _cSunset     = SkyAtmo._cSunset     || (SkyAtmo._cSunset     = new THREE.Color(0xd83a1a));   // rouge sang
    const _cCorSunset  = SkyAtmo._cCorSunset  || (SkyAtmo._cCorSunset  = new THREE.Color(0xc83520));   // corona rouge
    const _cHaloSunset = SkyAtmo._cHaloSunset || (SkyAtmo._cHaloSunset = new THREE.Color(0x7a2f28));   // halo pourpre-rouge
    if(!SkyAtmo._cTmp) SkyAtmo._cTmp = new THREE.Color();
    SkyAtmo._cTmp.copy(_cNoon).lerp(_cSunset, horizonness);

    // CŒUR
    if(this.sunCore){
      this.sunCore.position.set(cx + sx, sy, cz + sz);
      this.sunCore.visible = SunState.sunVisible;
      this.sunCore.material.color.copy(SkyAtmo._cTmp);
      this.sunCore.scale.set(22 * sunsetGrow, 22 * sunsetGrow * flattenY, 1);
      this.sunCore.material.opacity = SunState.sunVisible
        ? Math.min(1, 0.55 + Math.max(0, sunY + 0.05) * 1.4) : 0;
    }
    // COURONNE — bascule vers le rouge profond plus tôt que le cœur (le pourtour
    // s'enflamme avant le centre)
    if(this.sunCorona){
      this.sunCorona.position.set(cx + sx, sy, cz + sz);
      this.sunCorona.visible = SunState.sunVisible;
      this.sunCorona.material.color.copy(_cNoon).lerp(_cCorSunset, horizonness);
      this.sunCorona.scale.set(46 * sunsetGrow, 46 * sunsetGrow * flattenY, 1);
      this.sunCorona.material.opacity = SunState.sunVisible
        ? 0.60 * (0.35 + horizonness * 0.75) : 0;
    }
    // HALO atmosphérique large — vire FRANCHEMENT au rouge-pourpre à l'horizon
    // (c'est lui qui teinte le ciel autour du soleil dramatique).
    if(this.sunHalo){
      this.sunHalo.position.set(cx + sx, sy, cz + sz);
      this.sunHalo.visible = SunState.sunVisible;
      this.sunHalo.material.color.copy(SunState.sunColor).lerp(_cHaloSunset, horizonness * 0.85);
      this.sunHalo.scale.set(140 * sunsetGrow * 1.05, 140 * sunsetGrow * 1.05, 1);
      this.sunHalo.material.opacity = SunState.sunVisible ? (0.30 + horizonness * 0.40) : 0;
    }
    // AIGRETTES — apparaissent à l'horizon, tournoient très lentement
    const raysVisible = SunState.sunVisible && horizonness > 0.30;
    for(let i=0;i<this.sunRays.length;i++){
      const ray=this.sunRays[i];
      ray.position.set(cx + sx, sy, cz + sz);
      ray.visible=raysVisible;
      ray.material.color.copy(SunState.sunColor);
      // longueur proportionnelle à l'inclinaison
      const rayLen = 38 + horizonness * 50;
      ray.scale.set(9, rayLen, 1);
      // rotation lente + offset par rai
      ray.material.rotation = (i / this.sunRays.length) * Math.PI * 2 + t * 0.03;
      ray.material.opacity = raysVisible ? 0.40 * horizonness * (0.85 + 0.15*Math.sin(t*0.6 + i)) : 0;
    }

    // ==================== LUNE — SOURCE LUMINEUSE BLANC-ARGENT ==============
    // M7-astres-ter : trois couches additives — disque + halo intérieur +
    // halo extérieur — donnent à la lune la présence d'une vraie source.
    const moonNightK = (1 - SunState.kDay * 0.85);
    if(this.moonDisk){
      this.moonDisk.position.set(cx + mx, my, cz + mz);
      this.moonDisk.visible = SunState.moonVisible;
      // Opacité TRÈS PRÉSENTE la nuit, dégradée la jour.
      const moonOp = SunState.moonVisible
        ? Math.min(1, 0.75 + Math.max(0, moonY)*0.50) * moonNightK
        : 0;
      this.moonDisk.material.opacity = moonOp;
      const moonHorizonness = Math.max(0, 1 - Math.max(0, moonY) * 3.5);
      const moonGrow = 1.0 + moonHorizonness * 0.25;
      this.moonDisk.scale.set(22 * moonGrow, 22 * moonGrow * (1 - moonHorizonness*0.04), 1);
    }
    if(this.moonInnerHalo){
      this.moonInnerHalo.position.set(cx + mx, my, cz + mz);
      this.moonInnerHalo.visible = SunState.moonVisible;
      // Halo intérieur dense — fait briller le disque.
      this.moonInnerHalo.material.opacity = SunState.moonVisible
        ? 0.80 * moonNightK : 0;
    }
    if(this.moonHalo){
      this.moonHalo.position.set(cx + mx, my, cz + mz);
      this.moonHalo.visible = SunState.moonVisible;
      // Halo extérieur large et net.
      this.moonHalo.material.opacity = SunState.moonVisible
        ? 0.70 * moonNightK : 0;
    }

    // VOILE doré : grand plan orienté vers la caméra, posé côté soleil (dynamique).
    // Suit l'azimut du soleil sur le plan XZ ; n'apparaît qu'aux heures basses.
    if(this.veil){
      this.veil.position.set(cx + SunState.sunDir.x * 180, 55, cz + SunState.sunDir.z * 180);
      this.veil.lookAt(cx, 30, cz);
      const veilK = Math.max(0, 1 - Math.max(0, sunY)*1.2) * Math.max(0, sunY + 0.05);
      this.veil.visible = veilK > 0.01;
      this.veil.material.opacity = 0.12 * veilK;
    }

    // GODRAYS : du soleil vers le sol, à proximité du disque. Suivent SunState.
    const godrayBase = SunState.sunVisible && sunY < 0.55 && sunY > -0.05;
    for(let i=0;i<this.godrays.length;i++){
      const ray=this.godrays[i];
      ray.position.set(cx + sx + 6 + i*4, sy - 12, cz + sz + (i-1)*6);
      ray.rotation.z = ray.userData.tilt + Math.sin(t*0.25 + i)*0.06;
      ray.rotation.y = Math.PI/2;
      ray.visible = godrayBase;
      const climaxK = Math.max(0, 1 - Math.abs(sunY - 0.10)*4);   // pic à hauteur ~10°
      ray.material.opacity = godrayBase
        ? ray.userData.baseOp * climaxK * (0.85 + 0.15*Math.sin(t*0.4 + i*1.7))
        : 0;
    }

    // nuages : dérive est, garder l'altitude
    for(const c of this.clouds){
      const u=c.userData;
      u.angle += u.drift*dt;
      const x = cx + Math.cos(u.angle)*u.radius;
      const z = cz + Math.sin(u.angle)*u.radius;
      c.position.set(x, u.baseY, z);
      c.material.opacity = u.baseOp;
    }
  },
};
function buildSkyAtmosphere(){ SkyAtmo.build(); }
function updateSkyAtmosphere(dt){ SkyAtmo.update(dt); }

/* M2 — sélecteur qualité : Basse coupe ce qui anime / additionne du bloom
   (fumées de skyline, godrays, voile, nuages). Dôme + skyline + soleil restent. */
function _applyM2Quality(q){
  const live = (q !== 'low');
  // colonnes de fumée des cheminées lointaines
  for(const col of SMOKE_COLUMNS){
    for(const p of col.puffs){ p.obj.visible = live; }
  }
  if(SkyAtmo.ready){
    if(SkyAtmo.veil) SkyAtmo.veil.visible = live;
    for(const r of SkyAtmo.godrays) r.visible = live;
    for(const c of SkyAtmo.clouds) c.visible = live;
    // Couches du soleil + lune restent toujours (centre de chaque plan).
  }
}
if(typeof window !== 'undefined') window._applyM2Quality = _applyM2Quality;

/* =====================================================================
   M2 — LE CIEL. Dôme inversé r=380 (sous camera.far=400). ShaderMaterial
   à 3 arrêts verticaux pilotés par COLORSCRIPT (zénith bleu nuit / mid
   bleu-acier / horizon ambre 0xd98a3d) avec biais DIRECTIONNEL : l'ouest
   s'embrase, l'est se refroidit en bleu-gris. Dither anti-banding sur la
   couleur finale. depthWrite=false, fog=false : le dôme passe SOUS tout.
   uWestDir oriente le bias en monde — uniformes lisibles par DayCycle
   pour moduler le zénith jour/nuit sans toucher à l'horizon doré (DA fixe).
   ===================================================================== */
let skyDome=null, skyStars=null;
function buildSky(){
  const uniforms={
    uZenith:    {value:new THREE.Color(COLORSCRIPT.skyZenith)},   // 0x1b2433
    uMid:       {value:new THREE.Color(0x3d4a66)},
    uHorizon:   {value:new THREE.Color(COLORSCRIPT.skyHorizon)},  // 0xd98a3d
    uEastCool:  {value:new THREE.Color(0x4a5868)},                // est bleu-gris froid
    uWestDir:   {value:new THREE.Vector3(-1,0,0).normalize()},    // monde : -X = ouest
    uHorizonExp:{value:0.55},
    uMidExp:    {value:1.4},
    uTime:      {value:0},
  };
  // Alias rétro-compat DayCycle : moduler le zénith.
  // M8 — uMid et uHorizon ne sont PLUS verrouillés : DayCycle les fait
  // respirer aussi (cf. STOPS.mid / STOPS.horiz). Un mid slate fixe et un
  // horizon doré fixe donnaient un midi olive et sourd — or le ciel occupe
  // la moitié du cadre. L'inflexion dorée de la DA est préservée là où elle
  // signifie quelque chose : elle est REMISE à COLORSCRIPT.skyHorizon exact
  // à l'aurore et à l'heure dorée.
  uniforms.topColor = uniforms.uZenith;
  const mat=new THREE.ShaderMaterial({
    uniforms, side:THREE.BackSide, depthWrite:false, fog:false,
    vertexShader:`
      varying vec3 vWorldDir;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader:`
      uniform vec3  uZenith;
      uniform vec3  uMid;
      uniform vec3  uHorizon;
      uniform vec3  uEastCool;
      uniform vec3  uWestDir;
      uniform float uHorizonExp;
      uniform float uMidExp;
      uniform float uTime;
      varying vec3  vWorldDir;
      // dither 8-bit (anti-banding)
      float dither(vec2 fc){
        return fract(sin(dot(fc, vec2(12.9898,78.233)) + uTime*0.0001) * 43758.5453);
      }
      void main(){
        vec3 d = normalize(vWorldDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);          // 0 horizon-bas → 1 zénith
        // M-Peaufinage/E : dégradé à 4 PALIERS avec interpolations
        //   smoothstep — supprime les kinks de la version pow() précédente
        //   (qui laissait apparaître une « marche » près du zénith où le
        //   poids hMid clampait à 0). Le nouveau dégradé est nettement plus
        //   doux ; la perception du zénith est continue.
        //     c0 = horizon (0..0.18)
        //     c1 = mid bas (0.18..0.45)
        //     c2 = mid haut = mix(uMid, uZenith, 0.55) (0.45..0.78)
        //     c3 = zenith (0.78..1.0)
        vec3 c0 = uHorizon;
        vec3 c1 = uMid;
        vec3 c2 = mix(uMid, uZenith, 0.55);
        vec3 c3 = uZenith;
        float k01 = smoothstep(0.00, 0.18, h);
        float k12 = smoothstep(0.18, 0.45, h);
        float k23 = smoothstep(0.45, 0.78, h);
        vec3 vert = c0;
        vert = mix(vert, c1, k01);
        vert = mix(vert, c2, k12);
        vert = mix(vert, c3, k23);

        // BIAIS DIRECTIONNEL — embrasement à l'OUEST, refroidissement à l'EST.
        // westFactor positif vers l'ouest, négatif vers l'est. Cantonné au bas du ciel.
        float westFactor = dot(d, uWestDir);                 // [-1,+1]
        float lowMask    = smoothstep(0.55, -0.05, d.y);     // n'agit que près de l'horizon
        float warm       = clamp(westFactor, 0.0, 1.0) * lowMask;
        float cool       = clamp(-westFactor, 0.0, 1.0) * lowMask;
        // côté ouest : pousse vers l'horizon doré (embrasement)
        vec3 sky = mix(vert, uHorizon, warm * 0.55);
        // côté est : refroidit vers bleu-gris
        sky      = mix(sky,  uEastCool, cool * 0.40);

        // dither : ±0.5/255 sur chaque canal — élimine les bandes en bas du ciel
        float n = dither(gl_FragCoord.xy);
        sky += (n - 0.5) / 255.0;

        gl_FragColor = vec4(sky, 1.0);
      }`,
  });
  skyDome=new THREE.Mesh(new THREE.SphereGeometry(380,32,16),mat);
  skyDome.renderOrder=-2;
  scene.add(skyDome);
  // étoiles (enfants du dôme : suivent la caméra)
  const N=260, pos=new Float32Array(N*3);
  for(let i=0;i<N;i++){ const a=Math.random()*6.28, e=0.18+Math.random()*1.3, r=360;
    pos[i*3]=Math.cos(e)*Math.sin(a)*r; pos[i*3+1]=Math.sin(e)*r; pos[i*3+2]=Math.cos(e)*Math.cos(a)*r; }
  const sg=new THREE.BufferGeometry(); sg.setAttribute('position',new THREE.BufferAttribute(pos,3));
  skyStars=new THREE.Points(sg,new THREE.PointsMaterial({color:0xfff2d8,size:2.0,sizeAttenuation:false,
    transparent:true,opacity:0,depthWrite:false,fog:false}));
  skyStars.renderOrder=-1; skyDome.add(skyStars);
}

/* v58 — L'ATMOSPHÈRE : nappes de brume au ras du sol (fortes à l'heure dorée,
   presque dissipées à midi — asservies à DayCycle) et un SOLEIL visible dans le
   ciel (sprite à halo, insensible à la brume de profondeur), qui suit sa course. */
const Atmosphere={
  mists:[], sun:null, moon:null, ready:false,
  _mistTexture(){
    const c=document.createElement('canvas'); c.width=256; c.height=64; const x=c.getContext('2d');
    const g=x.createRadialGradient(128,32,4,128,32,120);
    g.addColorStop(0,'rgba(238,230,212,0.85)'); g.addColorStop(1,'rgba(238,230,212,0)');
    x.fillStyle=g; x.save(); x.scale(1,0.5); x.fillRect(0,0,256,128); x.restore();
    return new THREE.CanvasTexture(c);
  },
  _sunSprite(){
    const c=document.createElement('canvas'); c.width=c.height=256; const x=c.getContext('2d');
    let g=x.createRadialGradient(128,128,2,128,128,128);
    g.addColorStop(0,'rgba(255,244,214,0.95)'); g.addColorStop(0.18,'rgba(255,238,196,0.85)');
    g.addColorStop(0.32,'rgba(255,228,170,0.28)'); g.addColorStop(1,'rgba(255,228,170,0)');
    x.fillStyle=g; x.fillRect(0,0,256,256);
    const m=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),
      transparent:true,depthWrite:false,fog:false}));
    m.scale.set(64,64,1); m.renderOrder=-1; return m;
  },
  init(){
    if(this.ready) return; this.ready=true;
    const tex=this._mistTexture();
    const spots=[[-92,-66],[-100,-34],[-94,46],[-78,68],[108,-46],[108,30],[64,84]]; // champs de l'ouest + littoral
    for(const [x,z] of spots){
      const m=new THREE.Mesh(new THREE.PlaneGeometry(30,9),
        new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:0.14,depthWrite:false}));
      m.rotation.x=-Math.PI/2; m.rotation.z=Math.random()*3;
      m.position.set(x,0.9+Math.random()*0.5,z);
      m.userData.home=x; m.userData.v=0.25+Math.random()*0.3;
      scene.add(m); this.mists.push(m);
    }
    this.sun=this._sunSprite(); scene.add(this.sun);
    // v60 — la lune : disque pâle et net, halo discret
    const c=document.createElement('canvas'); c.width=c.height=128; const x=c.getContext('2d');
    let g=x.createRadialGradient(64,64,2,64,64,64);
    g.addColorStop(0,'rgba(228,234,240,0.95)'); g.addColorStop(0.30,'rgba(218,226,236,0.85)');
    g.addColorStop(0.42,'rgba(210,220,232,0.18)'); g.addColorStop(1,'rgba(210,220,232,0)');
    x.fillStyle=g; x.fillRect(0,0,128,128);
    this.moon=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),
      transparent:true,depthWrite:false,fog:false}));
    this.moon.scale.set(34,34,1); this.moon.renderOrder=-1; scene.add(this.moon);
  },
  update(dt){
    if(!this.ready) return;
    const k=DayCycle.kDay;                                   // v60 : 0 = nuit, 1 = midi
    const mistK=0.05+0.17*(1-k);                             // brume forte à l'aube et au crépuscule
    for(const m of this.mists){
      m.position.x+=m.userData.v*dt;
      if(m.position.x>m.userData.home+12) m.position.x=m.userData.home-12;
      m.material.opacity=mistK*(0.7+0.3*Math.sin(t*0.4+m.userData.home));
    }
    // M7-soleil — le sprite Atmosphere.sun reste masqué (cf. init.js) et
    // Atmosphere.moon est désormais maîtrisé par SkyAtmo. On désactive ici
    // pour éviter le double-rendu/désalignement.
    if(this.sun) this.sun.visible=false;
    if(this.moon) this.moon.visible=false;
  }
};

/* v57 — LA NATURE PRÉCÈDE LE CAPITAL.
   Forêts denses et herbe par InstancedMesh : ~150 arbres et ~220 touffes pour
   5 draw calls. Toujours visibles (c'est de la géographie, pas du décor
   d'époque) : la carte n'est jamais nue, même en phase 0. Génération
   déterministe, hors zones / rue / eau / décors de carte. */
/* =====================================================================
   M7 — NATURE REFONDUE.
   4 gabarits d'arbres irréguliers, chaque gabarit = 1 InstancedMesh
   pour le tronc + 1 InstancedMesh pour le houppier (8 draw calls total).
   Tous les sommets de houppier déformés par bruit. Tous les troncs
   noueux (perturbation des sommets cylindriques). Variation per-instance :
   rotation Y, scale uniforme 0.8-1.3, légère inclinaison.
   Buissons : sphères déformées éparses (1 InstancedMesh).
   Herbes hautes : crossed-quads en InstancedMesh près de l'eau et des
   terres communes (texture alpha procédurale).
   Suppression de TOUS les cônes verts précédents.
   ===================================================================== */
function _M7_deformedSphere(r, segs=10, seed=0, deformity=0.20, sx=1, sy=1, sz=1){
  const geo=new THREE.SphereGeometry(r, segs, Math.max(5, Math.floor(segs/2)));
  const pos=geo.attributes.position;
  for(let i=0; i<pos.count; i++){
    const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i);
    const len=Math.hypot(x, y, z);
    if(len < 0.01) continue;
    const noise=(Math.sin(x*3+y*1.7+seed)
               + Math.sin(y*2.3+z*1.9+seed*1.3)
               + Math.sin(z*1.5+x*2.1+seed*0.7)) / 3.0;
    const factor=1 + noise*deformity;
    pos.setXYZ(i, x*factor*sx, y*factor*sy, z*factor*sz);
  }
  pos.needsUpdate=true;
  geo.computeVertexNormals();
  return geo;
}
const _M7_TREE_PARAMS = {
  chene:    { trunk:[0.42, 0.34, 2.6, 7], color:0x6b7a4a, hSec:0x5a6b3a, foliageY:2.2 },
  peuplier: { trunk:[0.30, 0.22, 3.6, 7], color:0x5a6b3a, hSec:0x6b7a4a, foliageY:3.0 },
  trogne:   { trunk:[0.58, 0.46, 1.4, 8], color:0x6b7a4a, hSec:0x556a3a, foliageY:1.3 },
  pin:      { trunk:[0.32, 0.24, 2.9, 7], color:0x3a4a2e, hSec:0x2a3a22, foliageY:2.0 },
};
function _M7_trunkGeo(kind){
  const [r1, r2, h, segs]=_M7_TREE_PARAMS[kind].trunk;
  const geo=new THREE.CylinderGeometry(r1, r2, h, segs);
  // sommets noueux : noise XZ sur les anneaux
  const pos=geo.attributes.position;
  for(let i=0; i<pos.count; i++){
    const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i);
    const r=Math.hypot(x, z);
    if(r < 0.001) continue;
    const n=Math.sin(y*5.0 + i*0.7)*0.05 + Math.sin(y*2.3 + x*4.0)*0.04;
    pos.setX(i, x*(1+n));
    pos.setZ(i, z*(1+n));
  }
  pos.needsUpdate=true;
  geo.translate(0, h/2, 0);                  // pied à y=0
  geo.computeVertexNormals();
  return geo;
}
function _M7_foliageGeo(kind){
  const parts=[];
  if(kind==='chene'){
    // 4 lobes déformés, asymétriques
    let s=_M7_deformedSphere(1.45, 10, 11, 0.22, 1.0, 0.85, 1.0); parts.push(s);
    s=_M7_deformedSphere(1.10, 9, 23, 0.20); s.translate(0.85, 0.30, -0.25); parts.push(s);
    s=_M7_deformedSphere(0.95, 9, 41, 0.22); s.translate(-0.65, 0.45, 0.55); parts.push(s);
    s=_M7_deformedSphere(0.80, 8, 57, 0.25); s.translate(0.30, -0.40, 0.60); parts.push(s);
  } else if(kind==='peuplier'){
    // fuselage vertical : 2 lobes empilés très verticaux
    let s=_M7_deformedSphere(1.0, 9, 13, 0.16, 0.62, 2.20, 0.62); parts.push(s);
    s=_M7_deformedSphere(0.72, 8, 29, 0.18, 0.55, 1.60, 0.55); s.translate(0.10, 2.0, 0.05); parts.push(s);
  } else if(kind==='trogne'){
    // têtard : un gros chapeau et 2 repousses
    let s=_M7_deformedSphere(1.45, 10, 17, 0.25, 1.35, 0.55, 1.35); parts.push(s);
    s=_M7_deformedSphere(0.65, 8, 31, 0.30); s.translate(-0.85, 0.35, 0.40); parts.push(s);
    s=_M7_deformedSphere(0.55, 8, 43, 0.32); s.translate(0.75, 0.40, -0.30); parts.push(s);
  } else if(kind==='pin'){
    // 5 étages aplatis, rayons décroissants, décalages latéraux
    for(let i=0; i<5; i++){
      const r=1.7 - i*0.25;
      const y=i*0.85;
      const dx=(i%2 ? 0.10 : -0.10);
      const dz=(i%3===0 ? -0.05 : 0.07);
      const s=_M7_deformedSphere(r, 9, 71+i*7, 0.18, 1.0, 0.32, 1.0);
      s.translate(dx, y, dz);
      parts.push(s);
    }
  }
  return mergeGeometries(parts, false);
}
function _M7_bushGeo(seed=0){
  // 1-2 sphères basses
  const parts=[];
  parts.push(_M7_deformedSphere(0.55, 8, seed+11, 0.28, 1.0, 0.65, 1.0));
  if(seed % 3 === 0){
    const s=_M7_deformedSphere(0.40, 7, seed+23, 0.30, 1.0, 0.70, 1.0);
    s.translate(0.45, 0.10, -0.15);
    parts.push(s);
  }
  const merged=mergeGeometries(parts, false);
  merged.translate(0, 0.35, 0);
  return merged;
}
let _M7_grassTexCache=null;
function _M7_grassTexture(){
  if(_M7_grassTexCache) return _M7_grassTexCache;
  const c=document.createElement('canvas'); c.width=64; c.height=96;
  const x=c.getContext('2d');
  x.clearRect(0,0,64,96);
  // 5-7 brins d'herbe verts (formes triangulaires fines + dégradé)
  for(let i=0; i<7; i++){
    const bx=4 + (i*9) + ((i*3)%6);
    const tx=bx + ((i%2 ? 4 : -3));
    const tone1=`rgba(${66+i*4},${94+i*5},${48+i*3},0.92)`;
    const tone2=`rgba(${52+i*3},${74+i*4},${36+i*2},0.94)`;
    const grad=x.createLinearGradient(bx, 96, tx, 12);
    grad.addColorStop(0, tone2); grad.addColorStop(1, tone1);
    x.fillStyle=grad;
    x.beginPath();
    x.moveTo(bx-1.6, 96); x.lineTo(bx+1.6, 96); x.lineTo(tx, 12);
    x.closePath(); x.fill();
  }
  // jaunis discrets en pointe
  for(let i=0; i<5; i++){
    x.fillStyle='rgba(200,180,100,0.20)';
    x.fillRect(8+i*10, 12+Math.random()*8, 2, 2);
  }
  const tex=new THREE.CanvasTexture(c);
  tex.colorSpace=THREE.SRGBColorSpace;
  _M7_grassTexCache=tex;
  return tex;
}
function _M7_grassGeo(){
  // 2 quads croisés. Chaque PlaneGeometry par défaut centré XY, vue +Z.
  // On veut un quad VERTICAL face caméra et un autre rotation Y 90°.
  const w=0.6, h=0.8;
  const g1=new THREE.PlaneGeometry(w, h);
  g1.translate(0, h/2, 0);
  const g2=new THREE.PlaneGeometry(w, h);
  g2.translate(0, h/2, 0);
  g2.rotateY(Math.PI/2);
  return mergeGeometries([g1, g2], false);
}

const Nature={
  built:false,
  build(){
    if(this.built) return; this.built=true;
    let seed=42; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
    const KEEP_OUT=[[-98,92,16],[58,-100,22],[-86,-78,13],[-62,-86,12],[-112,-44,12],[44,-86,13],[88,72,12]];
    const ok=(x,z)=>{
      if(Math.abs(x)>116||Math.abs(z)>116) return false;
      if(x>106) return false;
      if(Math.abs(z)<12 && x>-112 && x<106) return false;
      if(zones.some(zz=>((zz.pos.x-x)**2+(zz.pos.z-z)**2)<15*15)) return false;
      if(KEEP_OUT.some(([kx,kz,kr])=>((kx-x)**2+(kz-z)**2)<kr*kr)) return false;
      return true;
    };

    // ============ ARBRES — 4 gabarits, distribution régionale ============
    // - chêne / trogne : zones rurales (W, S), forêts dispersées
    // - peuplier : alignés près de la rivière et des routes
    // - pin : couronne extérieure dense (conifères = lisière froide)
    const TOTAL=150;
    const trees=[];
    let guard=0;
    while(trees.length<TOTAL && guard++<3000){
      const edge=rnd()<0.74;
      const x=(rnd()*2-1)*116, z=(rnd()*2-1)*116;
      const d=Math.max(Math.abs(x),Math.abs(z));
      if(edge ? d<72 : d>=72) continue;
      if(!ok(x,z)) continue;
      // choix du gabarit selon distance + bruit régional
      const dist=d;
      let kind;
      if(dist >= 92 && rnd() < 0.7) kind='pin';
      else if(x < -60 && Math.abs(z) < 40 && rnd() < 0.55) kind='peuplier';
      else if(Math.abs(z) > 80 && rnd() < 0.35) kind='trogne';
      else kind = (rnd() < 0.65) ? 'chene' : 'trogne';
      const s=0.80 + rnd()*0.50;                          // 0.80 – 1.30
      trees.push({ x, z, kind, s, r:rnd()*Math.PI*2, tilt:(rnd()-0.5)*0.10 });
    }

    // groupe par gabarit
    const byKind={chene:[], peuplier:[], trogne:[], pin:[]};
    for(const t of trees) byKind[t.kind].push(t);

    // pour chaque gabarit : 1 IM tronc + 1 IM houppier
    const trunkColor=new THREE.Color(0x5a3e2a);
    const M=new THREE.Matrix4(), P=new THREE.Vector3(), Q=new THREE.Quaternion(), S=new THREE.Vector3();
    const E=new THREE.Euler(), Q2=new THREE.Quaternion();
    for(const kind of ['chene','peuplier','trogne','pin']){
      const list=byKind[kind];
      if(!list.length) continue;
      const tg=_M7_trunkGeo(kind);
      const fg=_M7_foliageGeo(kind);
      const matTronc=new THREE.MeshStandardMaterial({color:0x46362a, roughness:0.95, metalness:0, flatShading:true});
      const matFol=new THREE.MeshStandardMaterial({
        color:_M7_TREE_PARAMS[kind].color, roughness:1.0, metalness:0, flatShading:true,
      });
      const trunks=new THREE.InstancedMesh(tg, matTronc, list.length);
      const folies=new THREE.InstancedMesh(fg, matFol, list.length);
      trunks.castShadow=false; trunks.receiveShadow=true;
      folies.castShadow=true; folies.receiveShadow=true;
      const foY=_M7_TREE_PARAMS[kind].foliageY;
      const trunkH=_M7_TREE_PARAMS[kind].trunk[2];
      list.forEach((t, i)=>{
        // Euler : Y rotation + petit tilt aléatoire X/Z
        E.set(t.tilt*Math.sin(t.r), t.r, t.tilt*Math.cos(t.r), 'YXZ');
        Q.setFromEuler(E);
        // tronc — base à y=0, scaling uniforme
        P.set(t.x, 0, t.z); S.set(t.s, t.s, t.s);
        M.compose(P, Q, S); trunks.setMatrixAt(i, M);
        // houppier — au-dessus du tronc, scale identique
        P.set(t.x, (foY + 0.4)*t.s, t.z);
        S.set(t.s, t.s, t.s);
        M.compose(P, Q, S); folies.setMatrixAt(i, M);
      });
      trunks.instanceMatrix.needsUpdate=true;
      folies.instanceMatrix.needsUpdate=true;
      scene.add(trunks); scene.add(folies);
    }

    // ============ BUISSONS — sphères déformées éparses ============
    const bushes=[]; guard=0;
    while(bushes.length<120 && guard++<3000){
      const x=(rnd()*2-1)*115, z=(rnd()*2-1)*115;
      if(!ok(x,z)) continue;
      bushes.push({ x, z, s:0.55+rnd()*0.6, r:rnd()*Math.PI*2, seed:Math.floor(rnd()*100) });
    }
    if(bushes.length){
      // partage 1 geometry pour tous (économique), variation par scale/rotation
      const bg=_M7_bushGeo(0);
      const bm=new THREE.MeshStandardMaterial({color:0x556b3a, roughness:1.0, metalness:0, flatShading:true});
      const bMesh=new THREE.InstancedMesh(bg, bm, bushes.length);
      bMesh.castShadow=false; bMesh.receiveShadow=true;
      bushes.forEach((b, i)=>{
        Q.setFromAxisAngle(new THREE.Vector3(0,1,0), b.r);
        P.set(b.x, 0, b.z);
        S.set(b.s*(0.9+Math.sin(b.seed)*0.15), b.s*(0.85+Math.cos(b.seed)*0.1), b.s*(0.9+Math.sin(b.seed*1.3)*0.15));
        M.compose(P, Q, S); bMesh.setMatrixAt(i, M);
      });
      bMesh.instanceMatrix.needsUpdate=true;
      scene.add(bMesh);
    }

    // ============ HERBES HAUTES — crossed quads, près de l'eau & terres communes ============
    const gtex=_M7_grassTexture();
    const ggeo=_M7_grassGeo();
    const gmat=new THREE.MeshStandardMaterial({
      map:gtex, transparent:true, alphaTest:0.45, side:THREE.DoubleSide,
      roughness:1.0, metalness:0, flatShading:true, depthWrite:true,
    });
    // tirage : zones HERBEUSES = lisière W de la rivière (90<x<105) + terres communes (-115..-90, -45..-15)
    const grasses=[]; guard=0;
    while(grasses.length<180 && guard++<3000){
      const region=rnd();
      let x, z;
      if(region < 0.6){
        // bord de rivière
        x=90 + rnd()*16; z=(rnd()*2-1)*100;
      } else {
        // terres communes
        x=-118 + rnd()*30; z=-50 + rnd()*40;
      }
      if(!ok(x,z)) continue;
      grasses.push({ x, z, s:0.7+rnd()*0.7, r:rnd()*Math.PI*2 });
    }
    if(grasses.length){
      const gMesh=new THREE.InstancedMesh(ggeo, gmat, grasses.length);
      gMesh.castShadow=false; gMesh.receiveShadow=false;
      grasses.forEach((g, i)=>{
        Q.setFromAxisAngle(new THREE.Vector3(0,1,0), g.r);
        P.set(g.x, 0, g.z);
        S.set(g.s, g.s*(0.85+Math.random()*0.30), g.s);
        M.compose(P, Q, S); gMesh.setMatrixAt(i, M);
      });
      gMesh.instanceMatrix.needsUpdate=true;
      scene.add(gMesh);
    }

    // ============ TEINTES RÉGIONALES (préservées — donnent de la profondeur) ============
    const tint=(x,z,w,d,color,op)=>{
      const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),
        new THREE.MeshBasicMaterial({color, transparent:true, opacity:op, depthWrite:false}));
      m.rotation.x=-Math.PI/2; m.position.set(x, 0.008, z); scene.add(m);
    };
    tint(-96, 0, 52, 232, 0x7a8a55, 0.08);
    tint( 14,47,176, 38, 0x8a7a5f, 0.05);
    tint( 96, 0, 22,232, 0xc2a877, 0.07);
  }
};

/* v63 — TRAINS DE BOUFFÉES. Les cheminées (userData.chimney) émettent de
   vraies bouffées qui montent, grossissent, dérivent au vent d'ouest et se
   dissipent. Pool fixe de 22 bouffées, recensement des émetteurs toutes les
   2,5 s (les usines naissent, brûlent et meurent), position monde recalculée
   au lâcher. Le vieux y=15.5 forcé ne s'applique plus (bug v53 corrigé). */
const PuffTrains={
  puffs:[], emitters:[], _scanT:0, _spawnT:0, ready:false,
  init(){
    if(this.ready) return; this.ready=true;
    for(let i=0;i<30;i++){   // v66 : pool élargi (les villes lointaines fument aussi)
      const m=new THREE.Mesh(new THREE.SphereGeometry(0.8,7,6),
        new THREE.MeshStandardMaterial({color:0x9a9285,transparent:true,opacity:0,flatShading:true,depthWrite:false}));
      m.visible=false; scene.add(m);
      this.puffs.push({obj:m, t0:-99, life:3.4});
    }
  },
  scan(){
    this.emitters.length=0;
    scene.traverse(o=>{ if(o.userData&&o.userData.chimney&&o.visible){
      let p=o.parent, ok=true; while(p){ if(p.visible===false){ok=false;break;} p=p.parent; }
      if(ok) this.emitters.push(o); } });
  },
  update(dt){
    if(!this.ready) return;
    this._scanT-=dt; if(this._scanT<=0){ this._scanT=2.5; this.scan(); }
    this._spawnT-=dt;
    if(this._spawnT<=0 && this.emitters.length){
      this._spawnT=0.34;
      const free=this.puffs.find(pf=>t-pf.t0>pf.life);
      if(free){
        const e=this.emitters[Math.floor(Math.random()*this.emitters.length)];
        e.getWorldPosition(free.obj.position);
        free.t0=t; free.life=3.0+Math.random()*1.4; free.obj.visible=true;
      }
    }
    for(const pf of this.puffs){
      const a=(t-pf.t0)/pf.life;
      if(a>=1){ pf.obj.visible=false; continue; }
      pf.obj.position.y+=dt*(1.5+a*1.2);
      pf.obj.position.x+=dt*0.7;                              // le vent d'ouest (même sens que les nuages)
      pf.obj.scale.setScalar(0.5+a*1.7);
      pf.obj.material.opacity=0.42*(1-a)*(1-a*0.3);
    }
  }
};

/* =====================================================================
   M-Polish · LOT A — particules & atmosphère.
   Système MUTUALISÉ à pools pré-alloués, sprites ADDITIFS (+ quads pour
   la brume au sol). ZÉRO allocation par frame. Cap mesuré < 2 ms.

   Pools :
     • sparks  : 30 escarbilles orangées montant des cheminées proches
                 (intensité ∝ production active).
     • motes   : 30 motes de poussière en suspension près des lampes M4
                 (opacité modulée par proximité + facteur nuit).
     • steam   : 12 jets courts de vapeur basse (usine + port).
     • fog     : 5 nappes rasantes nocturnes (Terres communes + bord d'eau).

   Pilotage qualité (GRAPHICS_QUALITY) :
     low    → tout caché.
     medium → budget pool * 0.7.
     high   → 100 %.
   ===================================================================== */
const M_Polish = (function(){
  let ready = false;
  let _scene = null;
  const sparks = [];
  const motes  = [];
  const steam  = [];
  const fog    = [];
  let _texDot=null, _texCloud=null, _texFog=null;
  let _budgetMs = 0;
  const _tmpV = new THREE.Vector3();

  function _mkDotTex(){
    if(_texDot) return _texDot;
    const c=document.createElement('canvas'); c.width=c.height=64;
    const x=c.getContext('2d');
    const g=x.createRadialGradient(32,32,1,32,32,30);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(0.5,'rgba(255,255,255,0.55)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    x.fillStyle=g; x.fillRect(0,0,64,64);
    return _texDot = new THREE.CanvasTexture(c);
  }
  function _mkCloudTex(){
    if(_texCloud) return _texCloud;
    const c=document.createElement('canvas'); c.width=c.height=128;
    const x=c.getContext('2d');
    const g=x.createRadialGradient(64,72,4,64,72,60);
    g.addColorStop(0,'rgba(255,255,255,0.85)');
    g.addColorStop(0.45,'rgba(255,255,255,0.35)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    x.fillStyle=g; x.fillRect(0,0,128,128);
    return _texCloud = new THREE.CanvasTexture(c);
  }
  function _mkFogTex(){
    if(_texFog) return _texFog;
    const c=document.createElement('canvas'); c.width=c.height=256;
    const x=c.getContext('2d');
    const g=x.createRadialGradient(128,128,2,128,128,120);
    g.addColorStop(0,'rgba(190,200,215,0.55)');
    g.addColorStop(0.5,'rgba(190,200,215,0.18)');
    g.addColorStop(1,'rgba(190,200,215,0)');
    x.fillStyle=g; x.fillRect(0,0,256,256);
    return _texFog = new THREE.CanvasTexture(c);
  }

  function init(){
    if(ready) return;
    if(typeof scene === 'undefined' || !scene) return;
    _scene = scene;
    // SPARKS : sprites additifs, orange COLORSCRIPT forge.
    const sparkBase = new THREE.SpriteMaterial({
      map:_mkDotTex(), color:0xff7a30,
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
    });
    for(let i=0;i<30;i++){
      const s = new THREE.Sprite(sparkBase.clone());
      s.scale.set(0.22, 0.22, 1); s.visible = false;
      _scene.add(s);
      sparks.push({obj:s, life:0, t0:-9, vx:0, vy:0, vz:0});
    }
    // MOTES : sprites additifs en gas-light (ambre).
    const moteBase = new THREE.SpriteMaterial({
      map:_mkDotTex(), color:0xffb45e,
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      opacity:0,
    });
    for(let i=0;i<30;i++){
      const m = new THREE.Sprite(moteBase.clone());
      m.scale.set(0.12, 0.12, 1); m.visible = false;
      _scene.add(m);
      motes.push({obj:m, lamp:null, ox:0, oy:0, oz:0, ph:Math.random()*6.28});
    }
    // STEAM : sprites additifs gris-clair, prennent le fog (s'estompent au loin).
    const steamBase = new THREE.SpriteMaterial({
      map:_mkCloudTex(), color:0xc8c8d0,
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:true,
      opacity:0,
    });
    for(let i=0;i<12;i++){
      const s = new THREE.Sprite(steamBase.clone());
      s.scale.set(1.2, 1.2, 1); s.visible = false;
      _scene.add(s);
      steam.push({obj:s, t0:-9, life:2.2});
    }
    // GROUND FOG : quads horizontaux, opacity modulée par nuit, fog:true.
    const fogMat = new THREE.MeshBasicMaterial({
      map:_mkFogTex(), color:0xbcc4d0,
      transparent:true, depthWrite:false, fog:true,
      opacity:0, side:THREE.DoubleSide,
    });
    const fogSpots = [
      {x:-103, z:-30, r:14}, {x:-110, z:-22, r:11},   // Terres communes
      {x: 100, z:  4, r:13}, {x: 104, z: 14, r:11},   // port / bord d'eau
      {x:  98, z:-12, r:10},
    ];
    for(const sp of fogSpots){
      const f = new THREE.Mesh(new THREE.PlaneGeometry(sp.r*2, sp.r*2), fogMat);
      f.rotation.x = -Math.PI/2;
      f.position.set(sp.x, 0.08, sp.z);
      f.visible = false;
      _scene.add(f);
      fog.push({obj:f, x:sp.x, z:sp.z, ph:Math.random()*6.28});
    }
    // Lier chaque mote à une lampe à gaz (worldPos posée par M4.afterWorld).
    if(typeof gasLamps !== 'undefined' && gasLamps.length){
      for(let i=0;i<motes.length;i++){
        const lamp = gasLamps[i % gasLamps.length];
        motes[i].lamp = lamp;
        motes[i].ox = (Math.random()-0.5)*2.2;
        motes[i].oy = 1.0 + Math.random()*2.0;
        motes[i].oz = (Math.random()-0.5)*2.2;
      }
    }
    ready = true;
    console.info('[M-Polish/A] prêt · sparks:'+sparks.length+
      ' motes:'+motes.length+' steam:'+steam.length+' fog:'+fog.length);
  }

  function _qualFactor(){
    if(typeof GRAPHICS_QUALITY === 'undefined') return 1;
    if(GRAPHICS_QUALITY === 'low') return 0;
    if(GRAPHICS_QUALITY === 'medium') return 0.7;
    return 1.0;
  }

  function update(dt){
    if(!ready) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const qf = _qualFactor();
    if(qf <= 0){
      for(const s of sparks) if(s.obj.visible) s.obj.visible = false;
      for(const m of motes)  if(m.obj.visible) m.obj.visible = false;
      for(const s of steam)  if(s.obj.visible) s.obj.visible = false;
      for(const f of fog)    if(f.obj.visible) f.obj.visible = false;
      return;
    }
    const T = (typeof t !== 'undefined') ? t : 0;
    const cam = (typeof camera !== 'undefined') ? camera : null;
    const camx = cam ? cam.position.x : 0;
    const camz = cam ? cam.position.z : 0;
    const nightF = (typeof DayCycle !== 'undefined')
      ? Math.max(0, Math.min(1, 1 - DayCycle.kDay*1.7)) : 0.5;

    // — SPARKS — émission depuis cheminées (réutilise la liste scannée
    //   par PuffTrains : pas de double scan). Intensité ∝ production.
    const sparkBudget = Math.round(sparks.length * qf);
    const prodActive = (typeof state !== 'undefined' && state && state.productionActive);
    const emitRate = prodActive ? 14 : 4;     // spawns / s
    const chimneys = (typeof PuffTrains !== 'undefined' && PuffTrains.emitters) ? PuffTrains.emitters : null;
    if(chimneys && chimneys.length && Math.random() < emitRate * dt){
      // chercher une cheminée proche caméra (cheap : random + distance check).
      let pick=null, bestD2=140*140;
      for(let k=0;k<3;k++){
        const c = chimneys[(Math.random()*chimneys.length)|0];
        c.getWorldPosition(_tmpV);
        const dx=_tmpV.x-camx, dz=_tmpV.z-camz, d2=dx*dx+dz*dz;
        if(d2<bestD2){ pick=c; bestD2=d2; }
      }
      if(pick){
        for(let i=0;i<sparkBudget;i++){
          const s = sparks[i];
          if(s.life<=0 || T-s.t0 > s.life){
            pick.getWorldPosition(_tmpV);
            s.obj.position.set(_tmpV.x, _tmpV.y + 0.5 + Math.random()*0.7, _tmpV.z);
            s.t0 = T; s.life = 1.6 + Math.random()*1.0;
            s.vx = 0.6 + (Math.random()-0.5)*0.4;     // vent d'ouest cohérent
            s.vy = 1.4 + Math.random()*0.8;
            s.vz = (Math.random()-0.5)*0.3;
            s.obj.material.opacity = 1.0;
            s.obj.visible = true;
            break;
          }
        }
      }
    }
    for(let i=0;i<sparks.length;i++){
      const s = sparks[i];
      if(!s.obj.visible) continue;
      const age = (T - s.t0) / s.life;
      if(age >= 1 || i >= sparkBudget){ s.obj.visible = false; continue; }
      s.obj.position.x += s.vx * dt;
      s.obj.position.y += s.vy * dt;
      s.obj.position.z += s.vz * dt;
      s.obj.material.opacity = (1 - age) * (1 - age*0.4);
      s.obj.scale.setScalar(0.20 + age*0.18);
    }

    // — MOTES — poussière dans les cônes M4. Activée la nuit, proximité caméra.
    const motesBudget = Math.round(motes.length * qf);
    for(let i=0;i<motes.length;i++){
      const m = motes[i];
      if(i >= motesBudget || !m.lamp || !m.lamp.worldPos){
        if(m.obj.visible) m.obj.visible = false; continue;
      }
      const dx = m.lamp.worldPos.x - camx;
      const dz = m.lamp.worldPos.z - camz;
      const d2 = dx*dx + dz*dz;
      const target = (d2 < 60*60) ? nightF * 0.50 * (1 - d2/(60*60)) : 0;
      if(target <= 0.005){
        if(m.obj.visible) m.obj.visible = false; continue;
      }
      m.obj.visible = true;
      m.obj.position.set(
        m.lamp.worldPos.x + m.ox + Math.sin(T*0.6 + m.ph)*0.10,
        m.lamp.worldPos.y - 1.5 + m.oy + Math.cos(T*0.4 + m.ph)*0.05,
        m.lamp.worldPos.z + m.oz + Math.sin(T*0.5 + m.ph + 1)*0.10
      );
      m.obj.material.opacity = target;
    }

    // — STEAM — jets courts près usine + port. Dérive douce + vent d'ouest.
    const steamBudget = Math.round(steam.length * qf);
    const STEAM_SRC = [
      {x: -10,  y: 1.4, z: 30},     // usine grille avant
      {x: -20,  y: 1.4, z: 26},     // usine grille arrière
      {x: 102,  y: 1.2, z:  4},     // port quai
    ];
    if(Math.random() < 6 * dt){
      for(let i=0;i<steamBudget;i++){
        const s = steam[i];
        if(T - s.t0 > s.life){
          const src = STEAM_SRC[(Math.random()*STEAM_SRC.length)|0];
          s.obj.position.set(src.x + (Math.random()-0.5)*1.2, src.y, src.z + (Math.random()-0.5)*1.2);
          s.t0 = T; s.life = 2.0 + Math.random()*1.0;
          s.obj.visible = true;
          break;
        }
      }
    }
    for(let i=0;i<steam.length;i++){
      const s = steam[i];
      if(!s.obj.visible) continue;
      const age = (T - s.t0) / s.life;
      if(age >= 1 || i >= steamBudget){ s.obj.visible = false; continue; }
      s.obj.position.y += dt * 0.80;
      s.obj.position.x += dt * 0.35;
      s.obj.scale.setScalar(0.9 + age*1.8);
      s.obj.material.opacity = 0.30 * (1 - age) * (1 - age*0.4);
    }

    // — GROUND FOG — nappe basse subtile, modulée par nuit.
    const fogTarget = nightF * 0.55;
    const fogOn = fogTarget > 0.02;
    for(const f of fog){
      f.obj.visible = fogOn;
      if(!fogOn) continue;
      f.obj.material.opacity = fogTarget;
      f.obj.position.y = 0.08 + Math.sin(T*0.30 + f.ph)*0.02;
    }

    if(t0) _budgetMs = _budgetMs*0.9 + (performance.now()-t0)*0.1;
  }

  function debug(){
    return {
      ready, budgetMs:+_budgetMs.toFixed(2),
      sparks: sparks.filter(s=>s.obj.visible).length+'/'+sparks.length,
      motes:  motes.filter(m=>m.obj.visible).length+'/'+motes.length,
      steam:  steam.filter(s=>s.obj.visible).length+'/'+steam.length,
      fog:    fog.filter(f=>f.obj.visible).length+'/'+fog.length,
    };
  }

  return { init, update, debug };
})();
if(typeof window !== 'undefined') window.__mpolish = M_Polish;

/* =====================================================================
   M-Polish · LOT B — MICRO-VIE.
   Vols d'oiseaux en V (lointains), chat errant dans le quartier
   ouvrier (clin d'œil à Stray), linge tendu qui bat au vent, fanions
   de toit qui oscillent, fumées domestiques fines depuis quelques
   maisons. Tout en pools fixes — ZÉRO alloc par frame.

   Couplé au cycle jour/nuit (oiseaux le jour seulement).
   Pilotage qualité : low → tout caché.
   ===================================================================== */
const M_Life = (function(){
  let ready = false;
  let _scene = null;

  // ---- VOLS D'OISEAUX EN V (lointains) ----
  // Chaque "skein" = un groupe de 5 sprites en formation V qui traverse
  // le ciel dans la direction +X (vent d'ouest), à grande altitude.
  const skeins = [];
  // ---- CHAT (5 volumes low-poly, déambule entre 3 points) ----
  let cat = null;        // { obj, head, tail, p:0..1, segIdx:0..2, sitT, state:'walk'|'sit' }
  // ---- LINGE (quads des cordes à linge) ----
  const linge = [];      // [{ obj, ph, baseRot }]
  // ---- FANIONS sur toits ----
  const fanions = [];    // [{ obj, ph }]
  // ---- FUMÉES DOMESTIQUES (pool de puffs fins) ----
  const homeSmoke = [];
  let _homeT = 0;
  let _budgetMs = 0;
  let _texSoft = null;

  function _mkSoftTex(){
    if(_texSoft) return _texSoft;
    const c=document.createElement('canvas'); c.width=c.height=64;
    const x=c.getContext('2d');
    const g=x.createRadialGradient(32,32,1,32,32,30);
    g.addColorStop(0,'rgba(255,255,255,0.92)');
    g.addColorStop(0.5,'rgba(255,255,255,0.40)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    x.fillStyle=g; x.fillRect(0,0,64,64);
    return _texSoft = new THREE.CanvasTexture(c);
  }

  // ----------- construction du CHAT low-poly --------------
  function _buildCat(){
    const g = new THREE.Group();
    g.name = 'Polish:cat';
    const FUR  = 0xb05a28;
    const FUR2 = 0x7a3c1c;
    const matFur  = new THREE.MeshStandardMaterial({color:FUR,  emissive:new THREE.Color(FUR),  emissiveIntensity:0.10, roughness:0.95, metalness:0, flatShading:true});
    const matFur2 = new THREE.MeshStandardMaterial({color:FUR2, emissive:new THREE.Color(FUR2), emissiveIntensity:0.10, roughness:0.95, metalness:0, flatShading:true});
    // corps
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.22), matFur);
    body.position.y = 0.20; g.add(body);
    // tête (à l'avant +Z)
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.18, 0.20), matFur);
    head.position.set(0, 0.24, 0.30); g.add(head);
    // 2 petites oreilles triangulaires (cônes)
    for(const sx of [-1, 1]){
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 4), matFur);
      ear.position.set(sx*0.06, 0.36, 0.30); g.add(ear);
    }
    // queue (penche vers le haut à l'arrière)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.32), matFur2);
    tail.position.set(0, 0.24, -0.32);
    tail.rotation.x = -0.40; g.add(tail);
    // 2 transversales en guise de pattes
    const legF = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.06), matFur2);
    legF.position.set(0, 0.08, 0.18); g.add(legF);
    const legB = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.06), matFur2);
    legB.position.set(0, 0.08, -0.18); g.add(legB);
    return { group:g, head, tail };
  }

  function init(){
    if(ready) return;
    if(typeof scene === 'undefined' || !scene) return;
    _scene = scene;

    // ---- 2 SKEINS d'oiseaux en V ----
    const birdMat = new THREE.SpriteMaterial({
      map:_mkSoftTex(), color:0x241f17,
      transparent:true, depthWrite:false, fog:true, opacity:0.85,
    });
    for(let k=0;k<2;k++){
      const skein = { sprites:[], y:38 + k*8, z: -60 + k*120, vx: 1.6 + k*0.4, phase:Math.random()*6.28 };
      // 5 sprites en V : (0,0), (-1,-1), (1,-1), (-2,-2), (2,-2)
      const OFFS = [[0,0], [-1.2,-1.0], [1.2,-1.0], [-2.4,-2.0], [2.4,-2.0]];
      for(const [ox, oz] of OFFS){
        const s = new THREE.Sprite(birdMat.clone());
        s.scale.set(1.2, 0.5, 1);
        s.visible = false;
        _scene.add(s);
        skein.sprites.push({obj:s, ox, oz});
      }
      skein.x = k===0 ? -120 : -60;
      skeins.push(skein);
    }

    // ---- CHAT ----
    const c = _buildCat();
    const QO = (typeof zonePos === 'function') ? zonePos('Quartier ouvrier') : {x:0, z:62};
    c.group.position.set(QO.x - 6, 0, QO.z + 2);
    _scene.add(c.group);
    cat = {
      obj: c.group, head: c.head, tail: c.tail,
      // 3 points de déambulation autour des maisons
      waypoints: [
        {x: QO.x - 6, z: QO.z + 2},
        {x: QO.x + 5, z: QO.z + 8},
        {x: QO.x + 9, z: QO.z - 4},
      ],
      segIdx: 0, p: 0,
      state: 'walk',
      sitT: 0,
      speed: 1.6,            // unités/sec
      _bobPh: Math.random()*6.28,
    };

    // ---- LINGE — scan unique des cordes à linge (tag posé en init) ----
    _scene.traverse(o=>{
      if(o.userData && o.userData.linge){
        linge.push({obj:o, ph:Math.random()*6.28, baseY:o.position.y, baseRotZ:o.rotation.z});
      }
    });

    // ---- FANIONS — 3 fanions sur toits, posés en world fixe ----
    const fanMat = new THREE.MeshStandardMaterial({color:0x8a2c1d, roughness:0.9, metalness:0, flatShading:true, side:THREE.DoubleSide});
    const poleMat = new THREE.MeshStandardMaterial({color:0x2a241c, roughness:0.6, metalness:0.4, flatShading:true});
    const FAN_SPOTS = [
      {x: QO.x - 5, y: 5.0, z: QO.z + 9},
      {x: QO.x + 4, y: 5.4, z: QO.z + 7},
      {x: QO.x + 8, y: 5.0, z: QO.z + 10},
    ];
    for(const sp of FAN_SPOTS){
      const grp = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.0, 0.04), poleMat);
      pole.position.y = 0.5; grp.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.30), fanMat);
      flag.position.set(0.27, 0.9, 0); grp.add(flag);
      grp.userData.flag = flag;
      grp.position.set(sp.x, sp.y, sp.z);
      _scene.add(grp);
      fanions.push({obj:grp, flag, ph:Math.random()*6.28});
    }

    // ---- FUMÉES DOMESTIQUES — pool de 8 puffs ----
    const homeMat = new THREE.SpriteMaterial({
      map:_mkSoftTex(), color:0x8a8275,
      transparent:true, depthWrite:false, blending:THREE.NormalBlending, fog:true, opacity:0,
    });
    const HOME_SRC = [
      // 5 mitons de toit dans le quartier ouvrier (offsets relatifs aux maisons)
      {x: QO.x - 6, y: 4.2, z: QO.z + 8},
      {x: QO.x - 2, y: 4.2, z: QO.z + 9},
      {x: QO.x + 3, y: 4.2, z: QO.z + 8.5},
      {x: QO.x + 6, y: 4.2, z: QO.z + 7.5},
      {x: QO.x + 9, y: 4.2, z: QO.z + 9},
    ];
    for(let i=0;i<8;i++){
      const s = new THREE.Sprite(homeMat.clone());
      s.scale.set(0.6, 0.6, 1); s.visible = false;
      _scene.add(s);
      homeSmoke.push({obj:s, t0:-9, life:3.0, src: HOME_SRC[i % HOME_SRC.length]});
    }

    ready = true;
    console.info('[M-Polish/B] prêt · skeins:'+skeins.length+
      ' cat:1 linge:'+linge.length+' fanions:'+fanions.length+
      ' homeSmoke:'+homeSmoke.length);
  }

  function _qual(){
    if(typeof GRAPHICS_QUALITY === 'undefined') return 1;
    if(GRAPHICS_QUALITY === 'low') return 0;
    if(GRAPHICS_QUALITY === 'medium') return 0.7;
    return 1.0;
  }

  function update(dt){
    if(!ready) return;
    const t0p = (typeof performance !== 'undefined') ? performance.now() : 0;
    const qf = _qual();
    const T = (typeof t !== 'undefined') ? t : 0;
    const kd = (typeof DayCycle !== 'undefined') ? DayCycle.kDay : 1;

    if(qf <= 0){
      // qualité basse : tout caché.
      for(const sk of skeins) for(const s of sk.sprites) if(s.obj.visible) s.obj.visible = false;
      if(cat) cat.obj.visible = false;
      for(const f of fanions) if(f.obj.visible) f.obj.visible = false;
      for(const s of homeSmoke) if(s.obj.visible) s.obj.visible = false;
      return;
    }

    // — SKEINS — visibles seulement le jour, dérive +X lente —
    const dayVis = kd > 0.3;
    for(const sk of skeins){
      sk.x += sk.vx * dt;
      if(sk.x > 140) sk.x = -140;     // wrap
      const beat = Math.sin(T * 8 + sk.phase) * 0.55;
      for(let i=0;i<sk.sprites.length;i++){
        const sp = sk.sprites[i];
        sp.obj.visible = dayVis;
        if(!dayVis) continue;
        sp.obj.position.set(sk.x + sp.ox, sk.y + Math.sin(T * 0.5 + i*0.4) * 0.4, sk.z + sp.oz);
        sp.obj.scale.y = 0.50 + Math.abs(beat) * 0.10;
      }
    }

    // — CHAT — déambulation entre 3 points, parfois pause assis —
    if(cat){
      cat.obj.visible = true;
      if(cat.state === 'walk'){
        const a = cat.waypoints[cat.segIdx];
        const b = cat.waypoints[(cat.segIdx + 1) % cat.waypoints.length];
        const dx = b.x - a.x, dz = b.z - a.z;
        const dist = Math.hypot(dx, dz) || 1;
        cat.p += (cat.speed * dt) / dist;
        if(cat.p >= 1){
          cat.p = 1; cat.state = 'sit'; cat.sitT = 0;
        }
        const x = a.x + dx * cat.p;
        const z = a.z + dz * cat.p;
        cat.obj.position.set(x, 0.06 + Math.abs(Math.sin(T*7 + cat._bobPh))*0.02, z);
        cat.obj.rotation.y = Math.atan2(dx, dz);
        // tête bouge légèrement
        cat.head.rotation.y = Math.sin(T*1.4 + cat._bobPh)*0.2;
        cat.tail.rotation.x = -0.40 + Math.sin(T*3 + cat._bobPh)*0.15;
      } else {
        // assis : queue qui oscille doucement, tête qui regarde alentour
        cat.sitT += dt;
        cat.obj.position.y = 0.06;
        cat.head.rotation.y = Math.sin(T*0.8)*0.5;
        cat.tail.rotation.x = -0.20 + Math.sin(T*0.9)*0.25;
        if(cat.sitT > 4.5){
          cat.segIdx = (cat.segIdx + 1) % cat.waypoints.length;
          cat.p = 0; cat.state = 'walk';
        }
      }
    }

    // — LINGE — léger battement (sinusoïde) sur position Y + rotation Z —
    for(let i=0;i<linge.length;i++){
      const l = linge[i];
      l.obj.rotation.z = l.baseRotZ + Math.sin(T*1.4 + l.ph) * 0.10;
      l.obj.position.y = l.baseY + Math.sin(T*1.0 + l.ph)*0.015;
    }

    // — FANIONS — oscillation lente bruitée —
    for(const f of fanions){
      f.flag.rotation.y = Math.sin(T*0.9 + f.ph)*0.30 + Math.sin(T*2.1 + f.ph)*0.10;
    }

    // — FUMÉES DOMESTIQUES — fins puffs montant doucement, peu fréquents —
    _homeT -= dt;
    if(_homeT <= 0){
      _homeT = 0.6 + Math.random()*0.8;
      const homeBudget = Math.round(homeSmoke.length * qf);
      for(let i=0;i<homeBudget;i++){
        const s = homeSmoke[i];
        if(T - s.t0 > s.life){
          s.obj.position.set(s.src.x + (Math.random()-0.5)*0.5, s.src.y, s.src.z + (Math.random()-0.5)*0.5);
          s.t0 = T; s.life = 2.4 + Math.random()*0.8;
          s.obj.visible = true;
          break;
        }
      }
    }
    for(const s of homeSmoke){
      if(!s.obj.visible) continue;
      const age = (T - s.t0) / s.life;
      if(age >= 1){ s.obj.visible = false; continue; }
      s.obj.position.y += dt * 0.45;
      s.obj.position.x += dt * 0.20;
      s.obj.scale.setScalar(0.45 + age*0.85);
      s.obj.material.opacity = 0.22 * (1 - age);
    }

    if(t0p) _budgetMs = _budgetMs*0.9 + (performance.now()-t0p)*0.1;
  }

  function debug(){
    return {
      ready, budgetMs:+_budgetMs.toFixed(2),
      skeins:skeins.length, linge:linge.length, fanions:fanions.length, homeSmoke:homeSmoke.length,
    };
  }

  return { init, update, debug };
})();
if(typeof window !== 'undefined') window.__mlife = M_Life;

/* v58 — LE PAYSAGE SONORE. Tout est synthétisé (aucun fichier) et mixé par
   PROXIMITÉ : un vent doux partout (souffle filtré, lentement modulé), des
   mouettes près de l'eau, le ronron grave des machines près des usines en
   activité. Démarre au premier geste (politique d'autoplay), touche B pour
   couper. Volumes volontairement discrets : une ambiance, pas une bande-son. */
const AmbientSound={
  ctx:null, master:null, started:false, muted:false,
  wind:null, windLfo:null, hum:null, humGain:null, _gullT:0,
  start(){
    if(this.started) return; this.started=true;
    try{
      const C=this.ctx=new (window.AudioContext||window.webkitAudioContext)();
      this.master=C.createGain(); this.master.gain.value=0.15; this.master.connect(C.destination);
      // — vent : bruit blanc bouclé -> passe-bas dont la fréquence respire
      const len=C.sampleRate*2, buf=C.createBuffer(1,len,C.sampleRate), d=buf.getChannelData(0);
      for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
      const src=C.createBufferSource(); src.buffer=buf; src.loop=true;
      const lp=C.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=380; lp.Q.value=0.6;
      const wg=C.createGain(); wg.gain.value=0.5;
      const lfo=C.createOscillator(); lfo.frequency.value=0.06;
      const lfoG=C.createGain(); lfoG.gain.value=140;
      lfo.connect(lfoG); lfoG.connect(lp.frequency);
      src.connect(lp); lp.connect(wg); wg.connect(this.master);
      src.start(); lfo.start(); this.wind=wg;
      // — machines : deux oscillateurs graves légèrement désaccordés -> passe-bas
      const o1=C.createOscillator(), o2=C.createOscillator();
      o1.type='sawtooth'; o2.type='sawtooth'; o1.frequency.value=54; o2.frequency.value=55.4;
      const hf=C.createBiquadFilter(); hf.type='lowpass'; hf.frequency.value=160;
      this.humGain=C.createGain(); this.humGain.gain.value=0;
      o1.connect(hf); o2.connect(hf); hf.connect(this.humGain); this.humGain.connect(this.master);
      o1.start(); o2.start();
    }catch(e){ this.ctx=null; }
  },
  gull(){
    const C=this.ctx; if(!C) return;
    const n=1+Math.floor(Math.random()*2);
    for(let i=0;i<n;i++){
      const t0=C.currentTime+i*(0.28+Math.random()*0.2);
      const o=C.createOscillator(); o.type='triangle';
      o.frequency.setValueAtTime(1250,t0);
      o.frequency.exponentialRampToValueAtTime(760,t0+0.16);
      o.frequency.exponentialRampToValueAtTime(1050,t0+0.30);
      const g=C.createGain(); g.gain.setValueAtTime(0.0001,t0);
      g.gain.exponentialRampToValueAtTime(0.09,t0+0.05);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+0.34);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0+0.4);
    }
  },
  cricket(){
    const C=this.ctx; if(!C) return;
    for(let i=0;i<3;i++){ const t0=C.currentTime+i*0.085;
      const o=C.createOscillator(); o.type='triangle'; o.frequency.value=4300+Math.random()*250;
      const g=C.createGain(); g.gain.setValueAtTime(0.0001,t0);
      g.gain.exponentialRampToValueAtTime(0.016,t0+0.015);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+0.07);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0+0.09); }
  },
  toggle(){ this.muted=!this.muted;
    if(this.master) this.master.gain.value=this.muted?0:0.15;
    if(typeof pushLog==='function') pushLog('Son', this.muted?'Ambiance coupée (B pour réactiver).':'Ambiance sonore active.','plain'); },
  update(dt){
    if(!this.ctx||this.muted||typeof Vehicle==='undefined') return;
    const vx=Vehicle.pos.x, vz=Vehicle.pos.z;
    const kd=(typeof DayCycle!=='undefined')?DayCycle.kDay:1;
    // mouettes (le jour) : probabilité croissante près de l'eau
    this._gullT-=dt;
    if(this._gullT<=0){ this._gullT=5+Math.random()*8;
      const dEau=Math.max(0,106-vx);
      if(kd>0.3 && dEau<60 && Math.random()< (1-dEau/60)*0.9) this.gull(); }
    // grillons (la nuit) — v60
    this._criT=(this._criT||0)-dt;
    if(this._criT<=0){ this._criT=0.9+Math.random()*1.6;
      if(kd<0.3 && Math.random()<0.8) this.cricket(); }
    // ronron : distance à l'usine active la plus proche (joueur + firmes vivantes)
    let best=1e9;
    if(typeof zonePos==='function' && typeof state!=='undefined' && state.travailleurs>0 && !state.enGreve){
      const u=zonePos('Usine'); best=Math.min(best,Math.hypot(vx-u.x,vz-u.z)); }
    if(typeof CompetitorWorld!=='undefined' && CompetitorWorld.revealed)
      for(const c of CompetitorWorld.firms()) if(c.vivant&&!c.enGreve)
        best=Math.min(best,Math.hypot(vx-c.district.x,vz-c.district.z));
    const target=best<46 ? 0.10*(1-best/46) : 0;
    const g=this.humGain.gain; g.value=g.value+(target-g.value)*Math.min(1,dt*2.5);
  }
};

/* =====================================================================
   M7 — SOURCE DE VÉRITÉ UNIQUE POUR LE SOLEIL ET LA LUNE.
   timeOfDay 0..1 boucle en DAY_PERIOD secondes (réglable).
     0.00 = minuit (sun nadir, lune zénith)
     0.25 = aube (sun lève à l'EST, lune se couche à l'OUEST)
     0.50 = midi (sun zénith)
     0.72 = HEURE DORÉE (identité DA)
     0.75 = crépuscule (sun se couche à l'ouest)
   M8 — le spawn n'est PLUS 0.72 mais DAWN_START (0.205, avant l'aube) :
   la partie s'ouvre sur un lever de soleil, puis se joue de jour.
     1.00 = minuit (loop)
   SunState.sunDir / moonDir : vecteurs unitaires dans le repère MONDE,
   utilisés par ABSOLUMENT TOUT (sunLight, moonLight, sun/moon disks,
   godrays, voile, traînée mer). Pas d'autre source de calcul.
   ===================================================================== */
const SunState = {
  sunDir:    new THREE.Vector3(0, 1, 0),   // direction de l'origine vers le soleil
  moonDir:   new THREE.Vector3(0, -1, 0),  // direction vers la lune
  sunVisible:  true,
  moonVisible: false,
  sunIntensity:  1.0,
  moonIntensity: 0.0,
  kDay: 1.0,                                // 0 = nuit profonde, 1 = plein soleil
  timeOfDay: 0.205,                         // M8 : démarre AVANT l'aube (cf. DAWN_START)
  // dominante (pour la traînée spéculaire de la mer & godrays)
  dominantDir2D: new THREE.Vector2(),       // xz normalisé de l'astre visible
  dominantColor: new THREE.Color(0xffd9a4),
  dominantIsMoon: false,
  sunColor:  new THREE.Color(0xffd9a4),
  // M7-astres-ter : lune en source BLANC-ARGENT FRANCHE (e8eef8 →
  // poussée vers un blanc presque pur pour qu'elle BRILLE sur la mer
  // et éclaire la scène). Contraste assumé avec le soleil rouge-sang.
  moonColor: new THREE.Color(0xeaf0fa),
};
// M8 — 240 s → 900 s. Le cycle complet dure 15 min, donc ~7 min de plein
// jour : après le lever, la partie se joue LARGEMENT de jour avant que le
// soir ne revienne. (À 240 s la nuit retombait au bout de 2 min de jeu.)
const DAY_PERIOD = 900;
const SUN_DISPLAY_R = 235;                  // distance pour les sprites célestes

/* M8 — LEVER DE SOLEIL D'OUVERTURE.
   La partie s'ouvre sur une nuit finissante (DAWN_START), et le soleil se
   lève en accéléré (×DAWN_SPEED) jusqu'au matin franc (DAWN_END).
   Déroulé mesuré : ~9 s le soleil franchit l'horizon, ~20 s la lumière est
   celle du plein jour (kDay = 1), ~43 s l'accélération s'arrête — le trailer
   d'intro (~35 s) EST donc le lever de soleil, et le joueur prend la main
   sur un monde déjà éclairé. Passé DAWN_END le temps reprend sa marche
   normale et ne rejoue plus jamais l'accélération (dawnIntroDone). */
const DAWN_START = 0.205;                   // soleil sous l'horizon, lueur à l'EST
const DAWN_END   = 0.42;                    // matin franc, le monde est clairement éclairé
const DAWN_SPEED = 4.5;                     // ≈43 s : le trailer (~35 s) EST le lever de soleil
let dawnIntroDone = false;

let timeOfDay = DAWN_START;
let TIME_SPEED = 1.0;                       // ajustable via touches `,` `.` `]` (cf. input)

// teinte du soleil en fonction de la hauteur
// M7-astres-bis : rougi vers le rouge SANG à l'horizon (soleil de
// crépuscule industriel chargé de fumée).
function _M7_sunColorFromHeight(out, sy){
  const cSang  = 0xd83a1a;     // rouge sang (horizon profond)
  const cAmbre = 0xff8a3d;     // ambre rouge
  const cDore  = 0xffc878;     // doré chaud
  const cBlanc = 0xfff1d4;     // blanc-chaud (zénith)
  const _ca=new THREE.Color(), _cb=new THREE.Color();
  if(sy < 0.10){
    // sang → ambre rouge — pic à l'horizon
    const u = Math.min(1, Math.max(0, (sy + 0.05) / 0.15));
    _ca.setHex(cSang); _cb.setHex(cAmbre);
    out.copy(_ca).lerp(_cb, u);
  } else if(sy < 0.40){
    // ambre rouge → doré
    const u = (sy - 0.10) / 0.30;
    _ca.setHex(cAmbre); _cb.setHex(cDore);
    out.copy(_ca).lerp(_cb, u);
  } else {
    // doré → blanc midi
    const u = Math.min(1, (sy - 0.40) / 0.50);
    _ca.setHex(cDore); _cb.setHex(cBlanc);
    out.copy(_ca).lerp(_cb, u);
  }
}

function updateSun(t01){
  const tau = t01 * Math.PI * 2;
  // soleil : un grand cercle est-zénith-ouest-nadir dans le plan XY (z=0 mid-meridian).
  //   timeOfDay = 0.25 → sun = ( +1, 0, 0)  (lever à l'EST)
  //   timeOfDay = 0.50 → sun = (  0,+1, 0)  (zénith)
  //   timeOfDay = 0.75 → sun = ( -1, 0, 0)  (couchant à l'OUEST)
  //   timeOfDay = 0.00 → sun = (  0,-1, 0)  (nadir / minuit)
  SunState.sunDir.set(Math.sin(tau), -Math.cos(tau), 0);
  SunState.moonDir.set(-Math.sin(tau), Math.cos(tau), 0);
  const sy = SunState.sunDir.y, my = SunState.moonDir.y;

  // kDay : smoothstep large autour de l'horizon
  const k = Math.min(1, Math.max(0, (sy + 0.15) / 0.30));
  SunState.kDay = k*k*(3 - 2*k);

  // intensités physiques
  SunState.sunIntensity  = Math.max(0, sy * 1.15);
  // M7-astres-ter : lune nettement plus présente — vraie source.
  // ×0.46 → ×0.70 (sans dépasser le soleil zénith ×1.15).
  SunState.moonIntensity = Math.max(0, my * 0.70);

  // visibilités (le mesh disparaît quand l'astre est trop bas)
  SunState.sunVisible  = sy > -0.04;
  SunState.moonVisible = my > -0.04;

  // couleurs
  _M7_sunColorFromHeight(SunState.sunColor, sy);

  // dominante pour reflet eau + godrays
  if(sy >= my){
    SunState.dominantDir2D.set(SunState.sunDir.x, SunState.sunDir.z);
    SunState.dominantColor.copy(SunState.sunColor);
    SunState.dominantIsMoon = false;
  } else {
    SunState.dominantDir2D.set(SunState.moonDir.x, SunState.moonDir.z);
    SunState.dominantColor.copy(SunState.moonColor);
    SunState.dominantIsMoon = true;
  }
  // normalise (au cas où)
  if(SunState.dominantDir2D.lengthSq() > 0.0001) SunState.dominantDir2D.normalize();
  SunState.timeOfDay = t01;
}

/* v57 — LE JOUR RESPIRE. Jamais de nuit (la lisibilité d'abord) : la lumière
   oscille lentement (~4 min) entre un matin doré, un midi clair et une fin
   d'après-midi ambrée aux ombres longues. Les réverbères se rallument quand
   le soleil baisse. Trois interpolations par frame : coût nul. */
const DayCycle={
  /* v60 — LE CYCLE COMPLET : aurore -> matin -> midi -> heure dorée -> crépuscule -> NUIT.
     Tout est défini par une table d'étapes (phase 0..1) interpolées : course et couleur
     de la lumière (le directionnel joue le soleil le jour, la LUNE la nuit), brouillard,
     teinte du ciel, éclat des lampes, et kDay (0 = nuit, 1 = midi) que toute l'atmosphère
     consomme : brume, étoiles, lune, nuages, oiseaux, grillons. La nuit est une nuit
     d'encre lavée, jouable : la lumière lunaire garde des ombres lisibles. */
  /* M8 — les p sont désormais ALIGNÉS SUR LA POSITION PHYSIQUE du soleil
     (sunDir.y = -cos(2π·timeOfDay)) : lever à 0.25, zénith à 0.50, coucher
     à 0.75. L'ancienne table était décalée (aurore à p=0.07 alors que le
     soleil était encore sous l'horizon) — ce qui rendait tout démarrage
     ailleurs qu'à 0.72 incohérent : ambiance de matin, ciel sans soleil.
     Les hemI de journée sont aussi relevés (le monde est plus clair). */
  PERIOD:420, lampBoost:0.6, kDay:1,
  STOPS:[
    {p:0.00, el:0.55, az:-2.60, sunC:0x8aa6d4, sunI:0.26, hemC:0x5d7086, hemI:0.46, fog:0x39414e, top:0x27303f, mid:0x3d4a66, horiz:0x5b4b54, lamp:1.6, k:0.00}, // minuit
    {p:0.18, el:0.55, az:-2.60, sunC:0x9db2d8, sunI:0.30, hemC:0x68798f, hemI:0.50, fog:0x424b5c, top:0x2e3a4e, mid:0x475672, horiz:0x6d5862, lamp:1.5, k:0.04}, // nuit finissante
    {p:0.25, el:0.12, az: 1.15, sunC:0xffb27a, sunI:0.50, hemC:0xb9a48c, hemI:0.58, fog:0xc9a98c, top:0x7d8fb0, mid:0x8a86a0, horiz:0xd98a3d, lamp:1.2, k:0.30}, // AURORE — soleil à l'horizon EST (horizon = DA)
    {p:0.32, el:0.45, az: 0.95, sunC:0xffd9a4, sunI:0.95, hemC:0xe8d8b8, hemI:0.78, fog:0xd2bd92, top:0x9bb0c8, mid:0x8fabca, horiz:0xecc99a, lamp:0.6, k:0.82}, // matin
    {p:0.50, el:0.95, az: 0.35, sunC:0xfff1d4, sunI:1.12, hemC:0xefe2c6, hemI:0.90, fog:0xd4cbb0, top:0x7fb0d4, mid:0xa8cbe4, horiz:0xe6e7dc, lamp:0.30,k:1.00}, // MIDI — zénith, ciel franchement diurne
    {p:0.66, el:0.60, az:-0.55, sunC:0xffe2b0, sunI:1.00, hemC:0xead9b4, hemI:0.80, fog:0xcfbd96, top:0x8fb0c8, mid:0x97bbd8, horiz:0xe7cfa6, lamp:0.45,k:0.95}, // après-midi
    {p:0.73, el:0.30, az:-0.95, sunC:0xffc98e, sunI:0.85, hemC:0xe2c9a2, hemI:0.68, fog:0xd2b88c, top:0x9bb0c8, mid:0x7d90ae, horiz:0xd98a3d, lamp:0.9, k:0.65}, // heure dorée (horizon = DA)
    {p:0.78, el:0.08, az:-1.15, sunC:0xff7d4a, sunI:0.50, hemC:0xb08a78, hemI:0.52, fog:0xc07a52, top:0x4c5a86, mid:0x5f6284, horiz:0xc06a3c, lamp:1.3, k:0.25}, // crépuscule — couchant OUEST
    {p:0.85, el:0.55, az:-2.60, sunC:0x8aa6d4, sunI:0.26, hemC:0x5d7086, hemI:0.46, fog:0x39414e, top:0x27303f, mid:0x3d4a66, horiz:0x5b4b54, lamp:1.6, k:0.00}, // nuit
    {p:1.00, el:0.55, az:-2.60, sunC:0x8aa6d4, sunI:0.26, hemC:0x5d7086, hemI:0.46, fog:0x39414e, top:0x27303f, mid:0x3d4a66, horiz:0x5b4b54, lamp:1.6, k:0.00}, // boucle
  ],
  _cA:null,_cB:null,
  // M7 — phase() = timeOfDay continue (alignée sur la position physique du
  // soleil). Le décalage 0.72 historique est porté par la valeur INITIALE
  // de timeOfDay (spawn = heure dorée).
  phase(){ return timeOfDay; },
  _mixColor(target,h1,h2,u){
    if(!this._cA){ this._cA=new THREE.Color(); this._cB=new THREE.Color(); }
    this._cA.setHex(h1); this._cB.setHex(h2); target.copy(this._cA).lerp(this._cB,u); },
  update(dt){
    if(!sunLight) return;
    // M7 — avance timeOfDay puis recompute SunState (source de vérité).
    // M8 — pendant le lever d'ouverture, le temps court ×DAWN_SPEED : le
    // soleil franchit l'horizon pendant le trailer, et la partie démarre en
    // plein jour. Le drapeau ne se relève jamais : un seul lever par session.
    if(typeof dt==='number' && dt>0){
      let speed = TIME_SPEED;
      if(!dawnIntroDone){
        if(timeOfDay >= DAWN_END || timeOfDay < DAWN_START) dawnIntroDone = true;
        else speed *= DAWN_SPEED;
      }
      timeOfDay += dt * speed / DAY_PERIOD;
      timeOfDay = ((timeOfDay % 1) + 1) % 1;
    }
    updateSun(timeOfDay);

    // Couleurs interpolées via la table STOPS (phase ≡ timeOfDay) — le mapping
    // est légèrement décalé par rapport à la position physique (STOPS p=0.40
    // pour midi, le sun est à zénith à timeOfDay=0.50) mais reste cohérent
    // dans la grande forme du cycle.
    const ph=this.phase(), S=this.STOPS;
    let a=S[0], b=S[1];
    for(let i=0;i<S.length-1;i++){ if(ph>=S[i].p&&ph<=S[i+1].p){ a=S[i]; b=S[i+1]; break; } }
    const u0=(ph-a.p)/Math.max(1e-6,b.p-a.p), u=u0*u0*(3-2*u0);

    // sunLight : position et intensité depuis SunState. Couleur depuis
    // SunState.sunColor (calculée par hauteur, plus précis que les STOPS).
    sunLight.position.copy(SunState.sunDir).multiplyScalar(SUN_DISPLAY_R*0.47);   // ~110
    sunLight.intensity = physI(SunState.sunIntensity);
    sunLight.color.copy(SunState.sunColor);

    // moonLight : ajouté en init, on l'alimente si présent.
    if(moonLight){
      moonLight.position.copy(SunState.moonDir).multiplyScalar(SUN_DISPLAY_R*0.47);
      moonLight.intensity = physI(SunState.moonIntensity);
      moonLight.color.copy(SunState.moonColor);
    }

    if(hemiLight){ hemiLight.intensity=physI(a.hemI+(b.hemI-a.hemI)*u);
      this._mixColor(hemiLight.color, a.hemC, b.hemC, u); }
    // M7 — moonAmbient : intensité dérivée de SunState.kDay
    if(nightAmbient) nightAmbient.intensity = physI(0.16) * Math.max(0, 1 - SunState.kDay);
    if(scene.fog) this._mixColor(scene.fog.color, a.fog, b.fog, u);
    // M7-astres-bis : RÉCHAUFFEMENT ROUGE du fog près du soleil couchant.
    // Si le soleil est visible et bas, on biaise la brume vers le rouge-pourpre
    // du halo (0x7a2f28) — la fumée industrielle s'embrase au crépuscule.
    if(scene.fog && SunState.sunVisible){
      const sH = Math.max(0, 1 - Math.max(0, SunState.sunDir.y) * 3.5);
      if(sH > 0.05){
        if(!this._cSunsetFog) this._cSunsetFog = new THREE.Color(0x7a2f28);
        scene.fog.color.lerp(this._cSunsetFog, sH * 0.22);
      }
    }
    this.kDay=SunState.kDay;            // source de vérité unique consommée par tout le reste
    if(skyDome){
      // M8 — les TROIS paliers du dégradé suivent maintenant l'heure : zénith
      // (topColor → uZenith), bande médiane (uMid) et horizon (uHorizon).
      // L'inflexion dorée de la DA n'est pas perdue : les STOPS aurore et
      // heure dorée reposent uHorizon sur COLORSCRIPT.skyHorizon exact.
      const U=skyDome.material.uniforms;
      if(U.topColor) this._mixColor(U.topColor.value, a.top, b.top, u);
      if(U.uMid)     this._mixColor(U.uMid.value,     a.mid, b.mid, u);
      if(U.uHorizon) this._mixColor(U.uHorizon.value, a.horiz, b.horiz, u);
      // M8 — uEastCool était figé sur un slate sombre : en plein jour il
      // creusait une bande sale à l'horizon EST. On le DÉRIVE de la bande
      // médiane, ramenée vers le slate d'origine à mesure que la nuit vient
      // (kDay=0 → exactement la valeur historique 0x4a5868).
      if(U.uEastCool && U.uMid){
        if(!this._cEastNight) this._cEastNight = new THREE.Color(0x4a5868);
        U.uEastCool.value.copy(U.uMid.value)
          .lerp(this._cEastNight, 1 - SunState.kDay * 0.85);
      }
      if(skyDome.material.uniforms.uTime)
        skyDome.material.uniforms.uTime.value=t;
      if(typeof camera!=='undefined'&&camera)
        skyDome.position.set(camera.position.x,0,camera.position.z);
      if(typeof skyStars!=='undefined'&&skyStars)
        skyStars.material.opacity=Math.pow(Math.max(0,1-this.kDay*1.6),1.5)*0.9;   // étoiles la nuit
    }
    this.lampBoost=a.lamp+(b.lamp-a.lamp)*u;
    // _el : élévation de l'astre dominant (sun ou lune) — encore lu par
    // Atmosphere pour gater la visibilité de la lune sprite (héritage).
    this._el = SunState.dominantIsMoon
      ? Math.asin(Math.max(-1, Math.min(1, SunState.moonDir.y)))
      : Math.asin(Math.max(-1, Math.min(1, SunState.sunDir.y)));
  }
};

/* v56 — LE CIEL ET L'EAU VIVENT : nuages qui dérivent, oiseaux qui tournoient,
   bateaux qui tanguent. Coût minuscule, présence énorme. */
const WorldBeauty={
  clouds:[], birds:[], ready:false,
  init(){
    if(this.ready) return; this.ready=true;
    for(let i=0;i<4;i++){ const c=createCloud();
      c.position.set(-120+i*70+Math.random()*30, 42+Math.random()*12, -90+Math.random()*180);
      c.userData.v=0.9+Math.random()*0.9; scene.add(c); this.clouds.push(c); }
    for(let i=0;i<5;i++){ const b=createBird(); scene.add(b);
      this.birds.push({obj:b, cx:-60+Math.random()*150, cz:-70+Math.random()*140,
        r:9+Math.random()*9, y:22+Math.random()*9, a:Math.random()*6.28, v:0.35+Math.random()*0.3, ph:Math.random()*6.28}); }
  },
  update(dt){
    if(!this.ready) return;
    const kd=(typeof DayCycle!=='undefined')?DayCycle.kDay:1;
    for(const c of this.clouds){ c.position.x+=c.userData.v*dt;
      if(c.position.x>140){ c.position.x=-140; c.position.z=-90+Math.random()*180; }
      c.children.forEach(m=>{ if(m.material) m.material.opacity=0.25+0.67*kd; }); }   // v60 : nuages d'encre la nuit
    for(const b of this.birds){ b.obj.visible=kd>0.2; if(!b.obj.visible) continue;   // v60 : les oiseaux se couchent
      b.a+=b.v*dt;
      const o=b.obj; o.position.set(b.cx+Math.cos(b.a)*b.r, b.y+Math.sin(t*2+b.ph)*0.8, b.cz+Math.sin(b.a)*b.r);
      o.rotation.y=-b.a;                                      // tangent au cercle
      const f=Math.sin(t*9+b.ph)*0.55;                        // battement d'ailes
      if(o.userData.w1){ o.userData.w1.rotation.z=f; o.userData.w2.rotation.z=-f; } }
    for(const bt of _boats){ bt.position.y=Math.sin(t*1.1+bt.position.z)*0.12;
      bt.rotation.z=Math.sin(t*0.9+bt.position.z)*0.04; }
  }
};

/* v53 — navetteurs : la force de travail vit au quartier ouvrier COMMUN et
   marche chaque jour vers chaque usine — la tienne comme les leurs. Un
   navetteur par firme vivante, en boucle (aller au travail / retour). */
CompetitorWorld.commuters=[];
CompetitorWorld.updateCommuters=function(dt){
  if(!this.revealed) return;
  const QO=zonePos('Quartier ouvrier'); if(!QO) return;
  const firms=this.firms();
  // initialisation paresseuse
  if(!this.commuters.length){
    for(const c of firms){
      // M-Peuple-proc : navetteurs en marche, tintés à la firme.
      const f = spawnFigure({ type:'ouvrier', anim:'walk', tint: c.couleur });
      scene.add(f);
      this.commuters.push({obj:f, firm:c, p:Math.random()});
    }
  }
  for(const cm of this.commuters){
    const c=cm.firm, o=cm.obj;
    const ok=c.vivant && !c.enGreve && c.workers>0;
    o.visible=ok; if(!ok) continue;
    cm.p=(cm.p+dt/14)%1;                                   // ~14 s pour un aller-retour
    const k=cm.p<0.5? cm.p*2 : (1-cm.p)*2;                  // aller puis retour
    const tx=c.district.x+3.5, tz=c.district.z+6.5;
    o.position.set(QO.x+(tx-QO.x)*k, 0, QO.z+(tz-QO.z)*k);
    o.rotation.y=Math.atan2((cm.p<0.5?1:-1)*(tx-QO.x),(cm.p<0.5?1:-1)*(tz-QO.z));
    // M-Peuple-c : plus d'animation procédurale ; les commuters héritent
    // d'un Group invisible. Les navetteurs visibles sont gérés par Peuple.
  }
};

/* v49 — flux ambiants : le circuit des autres capitaux, visible dans l'espace.
   Toutes les ~4 s (hors modale), une firme vivante envoie ses marchandises au
   marché COMMUN ; selon son état, elle tire aussi de l'or de la banque (crédit)
   ou un ouvrier du marché du travail. Chaque caisse qui roule dit : mêmes
   institutions, mêmes débouchés, même circuit. */
CompetitorWorld.ambient=function(dt){
  if(!this.revealed || (typeof anyModalOpen==='function'&&anyModalOpen())) return;
  if(typeof shouldRunHeavySceneEffects==='function' && !shouldRunHeavySceneEffects()) return;
  this._amb=(this._amb||0)+dt;
  if(this._amb<4) return; this._amb=0;
  const alive=this.firms().filter(c=>c.vivant&&!c.enGreve);
  if(!alive.length) return;
  const c=alive[Math.floor(Math.random()*alive.length)];
  if(typeof fxCrate!=='function') return;
  fxCrate(c.zoneName,'Marché de vente',COL.rouge);                 // M′ → marché commun
  const r=Math.random();
  if(r<0.30 && c.debt>120) fxCrate('Banque',c.zoneName,COL.or);     // crédit : la même banque
  else if(r<0.55)          fxCrate('Marché du travail',c.zoneName,COL.bleu); // la même force de travail
  else if(c._justInvestedVisible){ fxCrate('Marché des moyens',c.zoneName,COL.brun); c._justInvestedVisible=false; }
};

/* v47 — Alertes progressives : le système prévient AVANT la crise, par paliers.
   Chaque alerte ne se déclenche qu'au franchissement du seuil (pas de spam),
   se réarme quand on redescend, et pointe le LIEU de la tension (halo rouge). */
const ALERTS=[
  {id:'colere1', zone:'Quartier ouvrier', test:s=>s.colere>0.45, msg:'La colère monte au quartier ouvrier. Le rapport social se tend.'},
  {id:'colere2', zone:'Quartier ouvrier', test:s=>s.colere>0.65, msg:'Colère ouvrière critique : la grève devient probable. Le point P du circuit est menacé.'},
  {id:'stocks1', zone:'Entrepôt',         test:s=>s.stocks>0.5*(STOCK_SEUIL+(s.stockCapaciteBonus||0)), msg:'Les stocks s’accumulent : la production dépasse la demande solvable.'},
  {id:'dette1',  zone:'Banque',           test:s=>s.dette>0.6*Math.max(1,s.plafondCredit||600), msg:'La dette approche du plafond : les intérêts pèsent sur chaque cycle, la banque devient méfiante.'},
  {id:'vente1',  zone:'Marché de vente',  test:s=>(s.d&&s.d.tauxVente!=null)&&s.d.tauxVente<0.75, msg:'Mévente : une grande partie de la production ne trouve pas d’acheteur. Crise de réalisation en germe.'},
  {id:'perte2',  zone:'Banque',           test:s=>(s._endStreaks&&s._endStreaks.alertPerte||0)>=2, msg:'Deux cycles déficitaires de suite : le capital avancé ne revient plus augmenté. La crise approche.'},
];
function checkAlerts(){
  const st=state; st._alerts=st._alerts||{};
  // streak de pertes pour l'alerte 'perte2' (réutilise le compteur endStreak)
  if(typeof endStreak==='function'){ const net=(st.d&&(st.d.resultatNet!=null?st.d.resultatNet:st.d.profitRealise))||0; endStreak(st,'alertPerte',net<0); }
  for(const a of ALERTS){
    const on=!!a.test(st);
    if(on && !st._alerts[a.id]){
      st._alerts[a.id]=true;
      pushLog('⚠ Alerte', a.msg, 'warn');
      if(typeof fxHalo==='function'){ fxHalo(a.zone, COL.rouge); fxPing(a.zone); }
      const pz=zonePos(a.zone); if(typeof floatText==='function') floatText('⚠ '+a.zone,{x:pz.x,y:13,z:pz.z},'warn');
    } else if(!on && st._alerts[a.id]){
      st._alerts[a.id]=false;   // réarmement : l'alerte pourra resservir si la tension revient
    }
  }
}
function markPressureExperience(s){
  const d=s.d||{};
  const pressure = (d.risqueCrise||0)>0.28 || (d.partJoueur!=null&&d.partJoueur<0.30)
    || s.stocks>35 || s.dette>160 || s.colere>0.38 || !!d.faillitesConc;
  if(pressure && !s._pressureExperienced){
    s._pressureExperienced=true;
    addHistoricalEvent('crise','Première pression systémique traversée : la formation sociale n’avance plus seulement par accumulation, mais par contradiction.');
  }
}
/* v47 — NEUTRALISÉ : ce panneau "période résolue" faisait doublon avec le bilan de cycle
   (il n'était d'ailleurs plus appelé). Conservé pour référence, court-circuité. */
function showPeriodDiagnostic(aged){
  return; // doublon du bilan — cf. showSocialCycleReport
  if(typeof showWhap!=='function') return;
  const d=state.d||{}, net=Math.round(d.resultatNet!=null?d.resultatNet:(d.profitRealise||0));
  const contr=dominantContradiction(state), pr=Math.round(ageProgress(state)*100);
  const fx=[
    ['résultat '+money(net), net>=0?'+':'-'],
    ['capital '+money(Math.round(state.argent)), state.argent>=0?'+':'-'],
    ['stocks '+Math.round(state.stocks), state.stocks>80?'-':'+'],
    ['âge '+(AGES[state.age||1]||'Atelier'), '+'],
    ['progression '+pr+' %', '+']
  ];
  const chain=[
    `Période ${state.cycle} résolue`,
    `Contradiction dominante : ${contr}`,
    `Actions réinitialisées : 3 interventions possibles`,
    aged?'Passage d’âge : la carte et les règles changent':'Le cycle productif est calculé en arrière-plan'
  ];
  showWhap({
    action:`Période résolue : <b>${net>=0?'profit':'perte'} ${money(net)}</b>.`,
    fx, chain,
    marx:'Le circuit fonctionne maintenant comme une <b>contrainte systémique</b> : tu n’es plus obligé de faire le tour, mais chaque période rappelle ce qui bloque la formation sociale.'
  });
}
const CycleCinematic={
  active:false, start:0, duration:6400, points:[], labels:[], lastIndex:-1,
  actors:null, workers:[], money:[], goods:[], savedVehicle:null, savedCargo:null,
  begin(labels,duration){
    this.active=true; this.start=performance.now(); this.duration=duration||6400; this.labels=labels||[]; this.lastIndex=-1;
    this.points=CIRCUIT.map(c=>{ const p=zonePos(c.zone); return new THREE.Vector3(p.x,0,p.z); });
    this.savedVehicle={pos:Vehicle.pos.clone(), heading:Vehicle.heading, speed:Vehicle.speed};
    this.savedCargo=(typeof MiniCircuit!=='undefined'?MiniCircuit.cargo:null);
    Vehicle.speed=0; Input.fwd=Input.back=Input.left=Input.right=false;
    this.buildActors();
  },
  buildActors(){
    this.clearActors();
    if(typeof scene==='undefined'||!scene) return;
    const g=new THREE.Group(); g.name='CycleCinematicActors'; scene.add(g); this.actors=g;
    const travail=zonePos('Marché du travail'), usine=zonePos('Usine'), banque=zonePos('Banque'), moyens=zonePos('Marché des moyens'), entrepot=zonePos('Entrepôt'), vente=zonePos('Marché de vente');
    const workerN=Math.max(4,Math.min(9,state.travailleurs||6));
    for(let i=0;i<workerN;i++){
      // M-Peuple-proc : acteurs cinématiques — ouvriers en marche.
      const w = spawnFigure({ type:'ouvrier', anim:'walk', tint: i%2 ? COL.bleu : COL.froid });
      const off={x:(i%3-1)*1.6, z:(Math.floor(i/3)-1)*1.3};
      w.position.set(travail.x+off.x,0,travail.z+off.z); w.visible=false; g.add(w);
      this.workers.push({obj:w,off,phase:Math.random()*6.28});
    }
    for(let i=0;i<10;i++){
      const coin=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.12,14),
        new THREE.MeshStandardMaterial({color:COL.or,metalness:.25,roughness:.45,flatShading:true}));
      coin.rotation.x=Math.PI/2; coin.visible=false; g.add(coin);
      this.money.push({obj:coin,phase:i/10,a:{x:banque.x,z:banque.z},b:{x:moyens.x,z:moyens.z},mode:'advance'});
    }
    for(let i=0;i<8;i++){
      const c=createCrate(1.15, i%2?0x9a5a3e:0x8a6b49); c.visible=false; g.add(c);
      this.goods.push({obj:c,phase:i/8,a:{x:usine.x,z:usine.z},b:{x:entrepot.x,z:entrepot.z},c:{x:vente.x,z:vente.z}});
    }
  },
  clearActors(){
    if(this.actors&&scene){ scene.remove(this.actors); }
    this.actors=null; this.workers=[]; this.money=[]; this.goods=[];
  },
  cargoFor(p){
    if(p<0.20) return 'argent';
    if(p<0.58) return 'moyens';
    return 'marchandises';
  },
  positionVehicle(p){
    if(!this.points.length||!Vehicle||!Vehicle.group) return;
    const span=this.points.length-1;
    const raw=p*span, idx=Math.min(span-1,Math.floor(raw)), local=raw-idx;
    const a=this.points[idx], b=this.points[Math.min(idx+1,span)];
    const pos=new THREE.Vector3().lerpVectors(a,b,local);
    const dx=b.x-a.x, dz=b.z-a.z;
    Vehicle.pos.copy(pos); Vehicle.heading=Math.atan2(dx,dz); Vehicle.speed=0;
    Vehicle.group.position.set(pos.x,0,pos.z); Vehicle.group.rotation.y=Vehicle.heading; Vehicle.group.rotation.z=0;
    if(typeof MiniCircuit!=='undefined') MiniCircuit.cargo=this.cargoFor(p);
    if(Vehicle.cargoGroups){ const cg=(typeof MiniCircuit!=='undefined'?MiniCircuit.cargo:this.cargoFor(p));
      for(const k in Vehicle.cargoGroups) Vehicle.cargoGroups[k].visible=(k===cg); }
  },
  updateWorkers(p,dt){
    if(!this.workers.length) return;
    const travail=zonePos('Marché du travail'), usine=zonePos('Usine');
    const k=clamp((p-0.20)/0.32);
    const prodPulse=Math.max(0,Math.sin(clamp((p-0.48)/0.18)*Math.PI));
    this.workers.forEach((w,i)=>{
      const o=w.obj; o.visible=p>0.14 && p<0.82;
      if(!o.visible) return;
      const wave=Math.sin(performance.now()*0.003+w.phase)*0.5;
      const sx=travail.x+w.off.x, sz=travail.z+w.off.z;
      const ux=usine.x-5+w.off.x*0.9, uz=usine.z+4+w.off.z*0.8;
      o.position.set(sx+(ux-sx)*k,0,sz+(uz-sz)*k);
      o.rotation.y=Math.atan2(ux-sx,uz-sz);
      if(k>0.98){ o.position.x+=Math.sin(t*5+i)*0.35*prodPulse; o.position.z+=Math.cos(t*4+i)*0.28*prodPulse; }
      // M-Peuple-d : animation portée par le mixer GLTF, plus d'animateWorker.
    });
  },
  updateMoney(p){
    if(!this.money.length) return;
    const banque=zonePos('Banque'), vente=zonePos('Marché de vente');
    this.money.forEach((m,i)=>{
      const o=m.obj;
      const advance=p<0.34, realize=p>0.78;
      o.visible=advance||realize;
      if(!o.visible) return;
      const a=advance?m.a:{x:vente.x,z:vente.z};
      const b=advance?m.b:{x:banque.x,z:banque.z};
      const base=advance ? p/0.34 : (p-0.78)/0.22;
      const k=(base+m.phase)%1;
      o.position.set(a.x+(b.x-a.x)*k,2.2+Math.sin(k*Math.PI)*3.2,a.z+(b.z-a.z)*k);
      o.rotation.z+=0.18; o.rotation.y+=0.10;
    });
  },
  updateGoods(p){
    if(!this.goods.length) return;
    this.goods.forEach((g,i)=>{
      const o=g.obj;
      o.visible=p>0.50 && p<0.96;
      if(!o.visible) return;
      let k=clamp((p-0.50)/0.46); let a=g.a, b=g.b;
      if(k>0.50){ a=g.b; b=g.c; k=(k-0.50)/0.50; }
      else { k=k/0.50; }
      const delay=(i%4)*0.04;
      k=clamp(k-delay);
      o.position.set(a.x+(b.x-a.x)*k+(i%3-1)*0.9,1.2+Math.sin(k*Math.PI)*1.6,a.z+(b.z-a.z)*k+Math.floor(i/3)*0.75);
      o.rotation.y+=0.03;
    });
  },
  update(){
    if(!this.active||!this.points.length) return;
    const p=clamp((performance.now()-this.start)/this.duration);
    const span=this.points.length-1;
    const raw=p*span, idx=Math.min(span-1,Math.floor(raw)), local=raw-idx;
    const a=this.points[idx], b=this.points[Math.min(idx+1,span)];
    const focus=new THREE.Vector3().lerpVectors(a,b,local);
    const drift=Math.sin(p*Math.PI*2)*10;
    const desired=new THREE.Vector3(focus.x-30+drift,78+Math.sin(p*Math.PI)*8,focus.z+34);
    camera.position.lerp(desired,0.12);
    camera.lookAt(focus.x,0,focus.z);
    this.positionVehicle(p);
    this.updateWorkers(p,0.04); this.updateMoney(p); this.updateGoods(p);
    if(idx!==this.lastIndex){
      this.lastIndex=idx;
      const c=CIRCUIT[Math.min(idx,CIRCUIT.length-1)];
      if(c){ fxHalo(c.zone, idx>=3?COL.rouge:COL.or); fxPing(c.zone); floatText(c.sym,{x:a.x,y:12,z:a.z}, idx>=3?'warn':'gain'); }
      if(idx===2) floatText('travail vivant', {x:focus.x,y:14,z:focus.z}, 'warn');
      if(idx===3) floatText('production', {x:focus.x,y:14,z:focus.z}, 'gain');
      if(idx===4) floatText('marchandises', {x:focus.x,y:14,z:focus.z}, 'gain');
    }
  },
  end(){
    this.active=false; this.points=[]; this.lastIndex=-1; this.clearActors();
    if(this.savedVehicle&&Vehicle){
      Vehicle.pos.copy(this.savedVehicle.pos); Vehicle.heading=this.savedVehicle.heading; Vehicle.speed=0;
      if(Vehicle.group){ Vehicle.group.position.set(Vehicle.pos.x,0,Vehicle.pos.z); Vehicle.group.rotation.y=Vehicle.heading; Vehicle.group.rotation.z=0; }
    }
    if(typeof MiniCircuit!=='undefined' && this.savedCargo!=null) MiniCircuit.cargo=this.savedCargo;
    this.savedVehicle=null; this.savedCargo=null;
  }
};
function playCycleAnimation(done){
  const ov=document.getElementById('cycleplay');
  if(!ov){ done(); return; }
  const steps=[...ov.querySelectorAll('.cpstep')];
  const bar=document.getElementById('cpbar');
  const txt=document.getElementById('cp-text');
  const title=document.getElementById('cp-title');
  const labels=['A — avance de capital','M — moyens et machines','Ft — force de travail','P — production','M′ — stocks / marchandises','A′ — vente / réalisation'];
  const explains=[
    'la trésorerie disponible et la dette lancent la période',
    'les moyens de production déterminent la capacité productive',
    'la main-d’œuvre, les salaires et la colère entrent dans le procès',
    'l’usine transforme travail et machines en marchandises',
    'les marchandises passent par l’entrepôt : stocks ou invendus apparaissent',
    'le marché réalise — ou non — la valeur sous forme d’argent'
  ];
  let start=performance.now(); const duration=6400;
  ov.classList.add('on'); refreshModalMode(); CycleCinematic.begin(labels,duration);
  function frame(now){
    const p=clamp((now-start)/duration); const i=Math.min(steps.length-1,Math.floor(p*steps.length));
    steps.forEach((s,k)=>s.classList.toggle('on',k===i));
    if(bar) bar.style.transform='scaleX('+p+')';   // scaleX plutôt que width : composité, pas de reflow
    if(txt) txt.textContent=labels[i]+' : '+explains[i]+'.';
    if(title) title.textContent='Vue drone du cycle productif';
    if(p<1) requestAnimationFrame(frame);
    else setTimeout(()=>{ CycleCinematic.end(); ov.classList.remove('on'); refreshModalMode(); done(); },300);
  }
  requestAnimationFrame(frame);
}
function showSocialCycleReport(aged){
  const s=state, d=s.d||{}, p=s.prev||{};
  const sheet=document.getElementById('report-sheet'); if(!sheet) return;
  const net=Math.round(d.resultatNet!=null?d.resultatNet:(d.profitRealise||0));
  const produites=Math.round(d.Q||0), vendues=Math.round(d.unitesVendues||0), invendus=Math.round(d.invendus||0);
  const pr=Math.round(ageProgress(s)*100);
  const reqs=ageRequirements(s);
  const reqHtml=reqs.length?`<div class="repsec">Passage vers ${nextAgeName(s)}</div><div class="objline">${reqs.map(r=>`<span class="${r.done?'gauge':'manque'}">${r.done?'✓':'□'} ${r.label} — ${r.value}</span>`).join('<br>')}</div>`:'';
  const regimeLabel=(REGIME_LABEL[s.regime?s.regime.type:'liberal']||'—');
  const recent=(s.history||[]).slice(0,4).map(e=>`<span class="lk">${e.text||e}</span>`).join('');
  const ageMsg=aged?`<p class="auto"><b>Passage d’âge.</b> La formation sociale change d’échelle : nouvelles règles, nouveaux risques, nouvelles contradictions.</p>`:'';
  sheet.innerHTML=`
    <div class="stamp">Bilan social · Cycle ${s.cycle} · An ${s.annee||1}</div>
    <h3>Bilan du cycle productif</h3>
    <p class="verdict ${net>=0?'ok':'ko'}">${net>=0?'✓ Cycle profitable':'✗ Cycle déficitaire'} — ${net>=0?'+ ':'− '}${money(Math.abs(net))}</p>
    ${ageMsg}
    <div class="led compte">
      <span class="k">Âge historique</span><span class="v gold">${AGES[s.age||1]||'Atelier'}</span>
      <span class="k">Rang</span><span class="v">${(s.ranking&&s.ranking.rankName)||'—'}</span>
      <span class="k">Progression vers ${nextAgeName(s)}</span><span class="v gold">${pr} %</span>
      <span class="k">Régime</span><span class="v blue">${regimeLabel}</span>
      <span class="k">Contradiction dominante</span><span class="v red">${dominantContradiction(s)}</span>
    </div>
    <div class="repsec">Compte du cycle</div>
    <div class="led compte">
      <span class="k">Capital au début</span><span class="v">${money(p.argent||0)}</span>
      <span class="k">Résultat productif</span><span class="v ${net>=0?'gold':'red'}">${net>=0?'+ ':'− '}${money(Math.abs(net))}</span>
      <span class="k">Frais / dette / État</span><span class="v red">${(d.interets||0)+(d.impot||0)>0?'− '+money((d.interets||0)+(d.impot||0)):'—'}</span>
      <span class="k">Capital final</span><span class="v gold">${money(s.argent)}</span>
      <span class="k">Dette finale</span><span class="v ${(s.dette||0)>0?'red':''}">${money(s.dette||0)}</span>
    </div>
    <div class="repsec">Production et réalisation</div>
    <div class="led">
      <span class="k">Produites</span><span class="v">${produites}</span>
      <span class="k">Vendues</span><span class="v gold">${vendues}</span>
      <span class="k">Invendues ce cycle</span><span class="v ${invendus>0?'red':''}">${invendus}</span>
      <span class="k">Stocks totaux</span><span class="v ${(s.stocks||0)>70?'red':''}">${Math.round(s.stocks||0)}</span>
      <span class="k">Prix unitaire</span><span class="v">${money2(s.prixUnitaire||0)}</span>
      <span class="k">Part de marché</span><span class="v">${pct(d.partJoueur||0)}</span>
    </div>
    <div class="repsec">Travail et conflit</div>
    <div class="led">
      <span class="k">Ouvriers employés</span><span class="v">${s.travailleurs||0}</span>
      <span class="k">Chômage</span><span class="v ${s.chomage>0.2?'red':''}">${pct(s.chomage||0)}</span>
      <span class="k">Colère ouvrière</span><span class="v ${s.colere>0.55?'red':''}">${pct(s.colere||0)}</span>
      <span class="k">Conscience collective</span><span class="v">${pct(s.conscience||0)}</span>
    </div>
    ${reqHtml}
    <div class="repsec">Journal récent</div>
    <div class="repchain">${recent || '<span class="lk">Aucun événement notable.</span>'}</div>
    <div class="interp"><div class="veilline">Lecture marxienne</div>Le cycle n’est plus seulement un trajet : il transforme les rapports sociaux. Le bilan indique ce que l’accumulation a produit — profit, dette, stocks, conflit, régime.</div>
    <button class="go" id="social-report-go">Continuer la période suivante ▸</button>`;
  document.getElementById('report').classList.add('on'); refreshModalMode();
  document.getElementById('social-report-go').onclick=()=>{ document.getElementById('report').classList.remove('on'); refreshModalMode();
    if(typeof maybeShowFirstContradiction==='function') maybeShowFirstContradiction();   // v47 — phase 3
    resumePlay(); };
}
function resolvePeriod(){
  if(gameMode==='commune') return resolveCommunePeriod();
  if(gameMode!=='socialFormation'||gameOver||anyModalOpen()) return;
  playCycleAnimation(()=>{
    cooldownReal=1.0;
    runCycle();
    const frais=fraisPeriode();
    if(frais>0){ state.argent-=frais; pushLog('Période',`Frais d’installation : −${frais} £. L’atelier jeune accumule lentement — le temps joue contre lui.`,'warn'); }
    state.actionsRestantes=3;
    if(state.cycle>0 && state.cycle%4===0) state.annee=(state.annee||1)+1;
    markPressureExperience(state);           // la Manufacture exige une contradiction traversée
    const aged=checkAgeTransition();         // l'âge peut basculer (utilise les seuils post-cycle)
    applyAgeRules(state);                    // règles structurelles de l'âge courant
    updateSocialGroups(state); updateRegime(state); computeRanking(state);
    evaluateHistoricalBifurcations(state); generativeChronicle();
    CompetitorWorld.onPeriod();               // v48 : le monde avance — décisions autonomes des firmes
    checkAlerts();                            // v47 : alertes progressives, par paliers
    checkObjectives();
    if(typeof buildSocialTableau==='function') buildSocialTableau();
    renderFormationPanel(); renderCircuitBar(); updateConsequences();
    if(!state._socialTutorialDone){
      state._socialTutorialDone=true;
      TutorialCoach.active=false;
      TutorialCoach.hide();
    } else tutorialCoachRefresh(true);
    const toBilan=()=>{
      showSocialCycleReport(aged);
      checkEndgame();
    };
    if(state.enGreve) showGreveConflict(toBilan); else toBilan();
  });
}

/* La MISE EN SCÈNE d'un mode : ce que l'écran doit montrer tant qu'on y est.
   Elle est SÉPARÉE de l'entrée dans le mode (enterSocialFormation,
   enterCommune), qui narre, débloque et révèle — et qui ne doit jouer
   qu'une fois.

   C'est très exactement ce qui bloquait une partie reprise : `.formation`
   est en `display:none` et n'a `display:block` qu'avec la classe `on`, or
   le seul endroit qui posait cette classe était enterSocialFormation().
   Une reprise restaure bien `gameMode='socialFormation'` et remplit le
   panneau — mais ne le montre jamais, et enterSocialFormation() ne peut
   plus rien réparer puisqu'elle sort d'entrée sur ce même `gameMode`. Le
   bouton « Lancer le cycle productif » vivant DANS ce panneau, la partie
   n'avançait plus d'un cycle.

   Tout ce qui est ici doit être idempotent et se déduire du seul `gameMode` :
   c'est la condition pour pouvoir le rejouer à chaque restauration. */
function stageMode(){
  const social = (gameMode==='socialFormation' || gameMode==='commune');
  const f=document.getElementById('formation'); if(f) f.classList.toggle('on', social);
  // On rend la main au CSS au lieu de forcer une valeur : le panneau de
  // quête a ses propres règles selon la largeur d'écran.
  const q=document.getElementById('quest'); if(q) q.style.display = social ? 'none' : '';
  const cb=document.getElementById('circuit'); if(cb) cb.style.display = (gameMode==='commune') ? 'none' : '';
  if(social){
    // Le circuit n'est plus une route à suivre : ni ligne, ni marqueur, ni
    // flèche au sol. moveTargetMarker() en cache déjà deux, mais il ne faut
    // pas dépendre de l'ordre des appels pour un état d'écran.
    if(circuitLine) circuitLine.visible=false;
    if(targetMarker) targetMarker.visible=false;
    if(groundArrow) groundArrow.visible=false;
  }
}

function enterSocialFormation(){
  if(gameMode==='socialFormation') return;
  gameMode='socialFormation';
  state.actionsRestantes=3; state.annee=1; state.age=Math.max(1,state.age||1); state._pressureExperienced=!!state._pressureExperienced;
  if(state.objIndex==null) state.objIndex=0; if(state.niveau==null) state.niveau=1;
  if(!state.regime) initRegime(state);
  if(!state.groups) initGroups(state);
  stageMode();
  updateSocialGroups(state); computeRanking(state); updateRegime(state); renderFormationPanel(); renderCircuitBar();
  if(typeof buildSocialTableau==='function') buildSocialTableau();
  addHistoricalEvent('age','Naissance de la formation sociale : le circuit devient une contrainte systémique.');
  CompetitorWorld.reveal();          // v48 : le monde dépasse le joueur — les autres capitaux apparaissent
  tutorialCoachRefresh(true);
  showConcept({stamp:'Formation sociale', title:'Le circuit devient une société',
    body:'<p>Tu as bouclé le circuit une fois, pas à pas. Désormais il tourne de lui-même — et tu n’es plus seul : d’autres capitaux produisent la même marchandise.</p><p>À chaque période, tu disposes de <b>trois interventions</b> : conduis vers un bâtiment, appuie sur <b>E</b>, choisis un bouton. Puis lance le cycle, en bas du panneau de droite, et lis le bilan.</p>',
    unlock:['3 interventions par période','En bas du panneau de droite : Lancer le cycle productif']});
}

function renderCommunePanel(){
  const c=state.commune; if(!c) return;
  const hx=cc=>'#'+((cc>>>0)&0xffffff).toString(16).padStart(6,'0');
  set('f-time',`An ${c.an} de la Commune`);
  set('f-age','La Commune'); set('f-rank','Producteurs associés');
  set('f-level','Commune'); set('f-obj','Coordonner le travail aux besoins');
  const couv=Math.min(1,(c.production+c.stocksCommuns)/Math.max(1,c.besoins));
  set('f-nextage','besoins couverts'); set('f-progpct',Math.round(couv*100)+' %');
  const pr=document.getElementById('f-prog'); if(pr) pr.style.width=Math.round(couv*100)+'%';
  let contra='Coordonner le travail aux besoins';
  if(c.bureaucratie>0.55) contra='Danger : la bureaucratie se sépare de la base';
  else if(c.penurie>0.5) contra='Danger : la pénurie use la Commune';
  else if(c.participation<0.35) contra='Danger : l’apathie démocratique';
  set('f-contra','Tension : '+contra);
  set('f-regime','Logique : association libre · plus d’accumulation');
  set('f-rules','Couvrir les besoins · démocratie vivante · pas d’appareil séparé');
  const gz=[['Besoins couverts',couv,COL.or],['Coordination',c.coordination,COL.bleu],
    ['Pénurie',c.penurie,COL.rouge],['Participation',c.participation,COL.vert],
    ['Bureaucratie',c.bureaucratie,COL.crise]];
  const gel=document.getElementById('f-gauges'); if(gel) gel.innerHTML=gz.map(g=>
    `<div class="gz"><span class="gn">${g[0]}</span><span class="gb"><i style="width:${Math.round(clamp(g[1])*100)}%;background:${hx(g[2])}"></i></span></div>`).join('');
  const grpEl=document.getElementById('f-groups'); if(grpEl) grpEl.innerHTML='';
  set('f-actnum',`${state.actionsRestantes} / 3`);
  const dots=document.getElementById('f-actdots'); if(dots) dots.innerHTML=[0,1,2].map(i=>`<div class="dot${i>=state.actionsRestantes?' used':''}"></div>`).join('');
  const cb=document.getElementById('f-cyclebox'), ch=document.getElementById('f-cyclehint');
  if(cb) cb.classList.toggle('ready', (state.actionsRestantes||0)<=0);
  if(ch) ch.textContent=(state.actionsRestantes||0)<=0 ? 'Maintenant : lance le cycle' : 'Après tes actions : lance le cycle';
  renderHistLog();
}
function renderFormationPanel(){
  if(gameMode==='commune') return renderCommunePanel();
  if(gameMode!=='socialFormation') return;
  if(typeof updateVilleBadge==='function') updateVilleBadge();
  const s=state, rk=s.ranking||computeRanking(s);
  set('f-time',`Cycle ${s.cycle} · An ${s.annee||1}`);
  set('f-age',AGES[s.age||1]||'Atelier'); set('f-rank',rk.rankName); set('f-nextage',nextAgeName(s));
  set('f-level','Niveau '+(s.niveau||1));
  const ob=currentObjective(s); set('f-obj', ob?('Objectif : '+ob.label+'  ·  +'+money(ob.r)):'Tous les objectifs accomplis');
  const p=Math.round(ageProgress(s)*100); set('f-progpct',p+' %');
  const pr=document.getElementById('f-prog'); if(pr) pr.style.width=p+'%';
  const reqEl=document.getElementById('f-reqs');
  if(reqEl){
    const reqs=ageRequirements(s);
    if(reqs.length){ reqEl.style.display='block'; reqEl.innerHTML='<div class="ah">Passage vers '+nextAgeName(s)+'</div>'+reqs.map(r=>{
        const cls=r.done?'done':(r.score<0.35?'block':'');
        return `<div class="req ${cls}"><span>${r.done?'✓':'□'} ${r.label}</span><span class="rv">${r.value}</span></div>`;
      }).join(''); }
    else { reqEl.style.display='none'; reqEl.innerHTML=''; }
  }
  set('f-contra','Contradiction dominante : '+dominantContradiction(s));
  set('f-regime','Régime : '+(REGIME_LABEL[s.regime?s.regime.type:'liberal']||'—'));
  set('f-rules', s.ageRules||AGE_RULES_DESC[s.age||1]||'—');
  const hx=c=>'#'+((c>>>0)&0xffffff).toString(16).padStart(6,'0');
  const gz=[['Productive',rk.productivePower,COL.brun],['Débouchés',rk.marketPower,COL.or],
    ['Dette',clamp(s.dette/600),COL.rouge],['Org. ouvrière',(s.regime?s.regime.workerPower:0),COL.bleu],
    ['Stabilité pol.',rk.politicalStability,COL.vert],['Risque crise',rk.crisisRisk,COL.crise]];
  const gel=document.getElementById('f-gauges'); if(gel) gel.innerHTML=gz.map(g=>
    `<div class="gz"><span class="gn">${g[0]}</span><span class="gb"><i style="width:${Math.round(clamp(g[1])*100)}%;background:${hx(g[2])}"></i></span></div>`).join('');
  set('f-actnum',`${s.actionsRestantes} / 3`);
  const dots=document.getElementById('f-actdots'); if(dots) dots.innerHTML=[0,1,2].map(i=>`<div class="dot${i>=s.actionsRestantes?' used':''}"></div>`).join('');
  const rb=document.getElementById('f-resolve');
  if(rb){ rb.textContent='Lancer le cycle productif ▸'; rb.title='Transforme tes interventions en production, vente, dette, stocks et conflit social.'; }
  const cb=document.getElementById('f-cyclebox'), ch=document.getElementById('f-cyclehint');
  if(cb) cb.classList.toggle('ready', (s.actionsRestantes||0)<=0);
  if(ch) ch.textContent=(s.actionsRestantes||0)<=0 ? 'Maintenant : lance le cycle' : 'Après tes actions : lance le cycle';
  const grpEl=document.getElementById('f-groups');
  if(grpEl && s.groups){ grpEl.innerHTML='<div class="fgh">Forces sociales</div>'+GROUP_VIEW.map(v=>{
      const gg=s.groups[v[1]]||{}; const force=clamp(gg.force||0); const sat=(gg.satisfaction!=null?gg.satisfaction:0.5);
      const tip=(gg.satisfaction!=null)?(sat>0.55?'satisfait':sat<0.4?'mécontent':'tendu'):'';
      return `<div class="gz"><span class="gn">${v[0]}</span><span class="gb"><i style="width:${Math.round(force*100)}%;background:${hx(v[3])}"></i></span><span class="sat" title="${tip}" style="opacity:${(0.3+sat*0.7).toFixed(2)}">●</span></div>`;
    }).join('');
    const w=s.groups.workers||{}, bk=s.groups.bankers||{}; const ranc=w.rancune||0, conf=w.confiance||0, mef=bk.mefiance||0;
    const memW = ranc>0.45?'<b style="color:'+hx(COL.rouge)+'">rancune tenace</b>':conf>0.45?'<b style="color:'+hx(COL.vert)+'">confiance</b>':ranc>0.2?'méfiance':'—';
    const memB = mef>0.45?' · banque : <b style="color:'+hx(COL.or)+'">méfiante</b>':'';
    grpEl.innerHTML+=`<div class="fmem">Mémoire ouvrière : ${memW}${memB}</div>`;
  }
  CompetitorWorld.renderRanking();   // v48 : classement industriel
  renderHistLog();
  if(state._socialTutorialDone) TutorialCoach.hide();
  else tutorialCoachRefresh();
}

// boutons (les éléments existent dans le HTML)
(function wireFormation(){
  const rb=document.getElementById('f-resolve'); if(rb) rb.addEventListener('click',resolvePeriod);
  // v47 : repli/dépli des détails de la formation sociale
  const dt=document.getElementById('f-details-toggle'), dd=document.getElementById('f-details');
  if(dt&&dd) dt.addEventListener('click',()=>{ const on=dd.style.display==='none';
    dd.style.display=on?'block':'none'; dt.textContent=(on?'▾':'▸')+' Détails de la formation sociale'; });
  const zc=document.getElementById('za-close'); if(zc) zc.addEventListener('click',()=>{ document.getElementById('zoneact').classList.remove('on'); refreshModalMode(); tutorialCoachRefresh(true); });
  const cic=document.getElementById('ci-close'); if(cic) cic.addEventListener('click',closeCircuitInfo);
  const cip=document.getElementById('circuit-info'); if(cip) cip.addEventListener('click',e=>{ if(e.target===cip) closeCircuitInfo(); });
})();

/* =====================================================================
   M9 — SAUVEGARDE DE LA PROGRESSION.

   PRINCIPE : on n'écrit QUE de la donnée de partie. Aucun Mesh, aucune
   référence THREE, aucune géométrie. Le monde 3D n'est pas sérialisé —
   il est RECONSTRUIT à partir de l'état au chargement (updateBuildings,
   CityGrowth, CompetitorWorld…), c'est-à-dire par le même chemin que le
   jeu emprunte déjà après chaque action du joueur (cf. applyUpgrade).
   La sauvegarde reste donc petite, et elle survit à toute évolution du
   décor : ajouter un bâtiment ou changer une texture ne l'invalide pas.

   SimulationState est de la donnée pure (nombres, booléens, objets et
   tableaux simples) : un aller-retour JSON suffit. On ne REMPLACE jamais
   l'instance `state` — les systèmes du moteur en gardent la référence ;
   on la ré-alimente par Object.assign. Un champ ajouté dans une version
   future et absent d'une vieille sauvegarde garde simplement sa valeur
   par défaut du constructeur : la compatibilité ascendante est gratuite.
   ===================================================================== */
const SAVE_KEY     = 'circuit-du-capital/partie';
const SAVE_VERSION = 1;
// M9 — TROIS EMPLACEMENTS. Une clé par emplacement : lire ou effacer l'un
// ne touche jamais les autres, et une sauvegarde corrompue n'emporte pas
// les deux parties voisines (ce qu'un index unique aurait fait).
const SAVE_SLOTS   = 3;
const saveKeyFor   = (i) => `${SAVE_KEY}/${i}`;
// Emplacement où écrivent les sauvegardes automatiques. Posé par l'accueil
// au moment où le joueur choisit sa partie ; null = personne n'a choisi,
// donc on n'écrit nulle part (on n'écrase jamais un emplacement au hasard).
let slotActif = null;
// Titre donné par le joueur à la partie en cours. Voyage dans l'aperçu de
// la sauvegarde pour que l'accueil puisse étiqueter une carte sans avoir à
// désérialiser toute la partie.
let titrePartie = '';
const TITRE_MAX = 40;
// Un titre vient du joueur : il ne doit JAMAIS être concaténé dans du HTML.
// Toutes les insertions passent par textContent (cf. Accueil.carte).
const nettoieTitre = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, TITRE_MAX);

/* Filtre de sérialisation. `state` n'est PAS entièrement pur : les systèmes
   du monde accrochent des références THREE dessus à l'exécution — surtout
   `competitors[i]._group` (le district 3D de chaque firme). Sérialiser
   naïvement produirait une sauvegarde énorme, voire une récursion. On coupe
   par nom ET par signature THREE, pour attraper aussi les accroches futures. */
const SAVE_SKIP_KEYS = new Set(['_group','group','mesh','sprite','material','geometry','parent']);
function saveReplacer(k, v){
  if(SAVE_SKIP_KEYS.has(k)) return undefined;
  if(v && typeof v==='object' &&
     (v.isObject3D || v.isVector3 || v.isColor || v.isMaterial || v.isBufferGeometry || v.isTexture))
    return undefined;
  return v;
}

const SaveGame = {
  lastError: null,

  // localStorage peut être absent, désactivé, ou lever (navigation privée,
  // quota, iframe cloisonnée). Tout passe par ce point d'accès unique.
  _store(){
    try{
      const s = window.localStorage;
      if(!s) return null;
      const probe = '__cdc_probe__';
      s.setItem(probe,'1'); s.removeItem(probe);
      return s;
    }catch(err){ this.lastError = err && err.message || String(err); return null; }
  },
  disponible(){ return !!this._store(); },

  /* --------------------------- ÉCRITURE --------------------------- */
  snapshot(){
    return {
      v: SAVE_VERSION,
      date: new Date().toISOString(),
      // en-tête lisible : sert à étiqueter la sauvegarde dans l'interface
      // sans avoir à désérialiser toute la partie.
      apercu: {
        titre:  titrePartie,
        cycle:  state.cycle,
        argent: Math.round(state.argent),
        phase:  gamePhase,
        age:    state.age || 1,
      },
      etat:    JSON.parse(JSON.stringify(state, saveReplacer)),
      journal: journalEntries.slice(0, 120),
      evenements: log.entries.slice(0, 200),
      histoire: historyLog.slice(0, 40),
      // conceptShown est un Set : JSON le sérialiserait en {}. On l'aplatit.
      conceptsVus: Array.from(conceptShown),
      progression: {
        step, gameOver, gamePhase, gameMode, pendingEnterSF,
        voileUnlocked, crisisStreak, activeDeck, guideMode, marxView,
        cargo:        MiniCircuit.cargo,
        niveauVille:  CityGrowth.level,
        // Non dérivables : ces bascules ne se rejouent pas toutes seules.
        concurrentsReveles: !!CompetitorWorld.revealed,
        quartierMarque:     !!PlayerDistrict.marked,
        coach: { active:TutorialCoach.active, hasMoved:TutorialCoach.hasMoved,
                 tourKey:TutorialCoach.tourKey, tourIndex:TutorialCoach.tourIndex },
        timeOfDay,
      },
      vehicule: Vehicle && Vehicle.pos
        ? { x:Vehicle.pos.x, y:Vehicle.pos.y, z:Vehicle.pos.z, cap:Vehicle.heading }
        : null,
      // séquences cinéma : « déjà vu » + mémoire de seuil de colère
      cinema: (typeof CinemaSequences!=='undefined' && CinemaSequences.etat)
        ? CinemaSequences.etat() : null,
    };
  },

  ecrire(slot){
    const i = (slot==null) ? slotActif : slot;
    // Aucun emplacement choisi = personne n'a encore ouvert de partie :
    // écrire ici écraserait un emplacement arbitraire. On s'abstient.
    if(i==null) return {ok:false, erreur:'aucun emplacement actif'};
    const s = this._store();
    if(!s){ return {ok:false, erreur:'stockage indisponible'}; }
    try{
      s.setItem(saveKeyFor(i), JSON.stringify(this.snapshot()));
      this.lastError = null;
      return {ok:true};
    }catch(err){
      // QuotaExceededError surtout : on ne casse pas la partie en cours.
      this.lastError = err && err.message || String(err);
      return {ok:false, erreur:this.lastError};
    }
  },

  /* Sauvegarde automatique : silencieuse et sans exception. Une écriture
     qui échoue (quota, mode privé) ne doit JAMAIS interrompre une partie —
     elle se signale dans le panneau, pas au milieu du jeu. */
  autosave(){
    const r = this.ecrire();
    if(typeof refreshSaveUI==='function') refreshSaveUI();
    return r.ok;
  },

  /* --------------------------- LECTURE ---------------------------- */
  lire(slot){
    const i = (slot==null) ? slotActif : slot;
    if(i==null) return null;
    const s = this._store(); if(!s) return null;
    try{
      const brut = s.getItem(saveKeyFor(i)); if(!brut) return null;
      const d = JSON.parse(brut);
      // On refuse une sauvegarde d'une version de format inconnue plutôt
      // que de restaurer à moitié une partie incohérente.
      if(!d || d.v !== SAVE_VERSION || !d.etat) return null;
      return d;
    }catch(err){ this.lastError = err && err.message || String(err); return null; }
  },
  // Les trois emplacements, dans l'ordre. `null` = emplacement libre.
  emplacements(){
    const out=[]; for(let i=0;i<SAVE_SLOTS;i++) out.push(this.lire(i));
    return out;
  },
  /* Un emplacement peut contenir des octets que lire() refuse : JSON abîmé,
     ou sauvegarde écrite par une version plus récente du jeu. Il ne faut
     PAS l'afficher comme libre — le joueur y lancerait une partie et
     écraserait sans le savoir une progression qu'il croyait en sécurité.
     On distingue donc « vide » de « occupé mais illisible ». */
  occupe(i){
    const s=this._store(); if(!s) return false;
    try{ return s.getItem(saveKeyFor(i)) != null; }catch(err){ return false; }
  },
  illisible(i){ return this.occupe(i) && !this.lire(i); },
  placesLibres(){
    let n=0; for(let i=0;i<SAVE_SLOTS;i++) if(!this.occupe(i)) n++;
    return n;
  },
  existe(slot){ return !!this.lire(slot); },
  effacer(slot){
    const i = (slot==null) ? slotActif : slot;
    if(i==null) return;
    const s=this._store(); if(s){ try{ s.removeItem(saveKeyFor(i)); }catch(err){} }
  },

  /* ------------------------- RESTAURATION ------------------------- */
  restaurer(d){
    if(!d || !d.etat) return false;
    // Le titre repart avec la partie : les sauvegardes automatiques
    // suivantes doivent continuer de l'écrire.
    titrePartie = nettoieTitre(d.apercu && d.apercu.titre);

    // 1. moteur économique — on ré-alimente l'instance existante.
    // Les firmes concurrentes portent une référence 3D VIVANTE (`_group`,
    // leur district déjà construit dans la scène). Remplacer le tableau par
    // la version désérialisée l'effacerait : les districts resteraient dans
    // la scène sans que plus personne ne puisse les montrer, les cacher ou
    // les mettre à jour. On garde donc les objets vivants et on ne réécrit
    // que leurs champs de données.
    const firmes = state.competitors;
    Object.assign(state, d.etat);
    state.d    = d.etat.d    || {};
    state.prev = d.etat.prev || {};
    if(Array.isArray(firmes) && Array.isArray(d.etat.competitors)){
      d.etat.competitors.forEach((donnees, i)=>{
        if(firmes[i]) Object.assign(firmes[i], donnees);
        else          firmes[i] = donnees;
      });
      firmes.length = d.etat.competitors.length;
      state.competitors = firmes;
    }

    // 2. journaux : bandeau compact, modale historique, chronique.
    journalEntries.length = 0;
    if(Array.isArray(d.journal)) journalEntries.push(...d.journal);
    log.entries.length = 0;
    if(Array.isArray(d.evenements)) log.entries.push(...d.evenements);
    lastLogLen = log.entries.length;
    historyLog.length = 0;
    if(Array.isArray(d.histoire)) historyLog.push(...d.histoire);
    conceptShown.clear();
    if(Array.isArray(d.conceptsVus)) d.conceptsVus.forEach(c=>conceptShown.add(c));

    // 3. progression hors moteur.
    const p = d.progression || {};
    if(typeof p.step==='number')        step        = p.step;
    if(typeof p.gameOver==='boolean')   gameOver    = p.gameOver;
    if(typeof p.gamePhase==='string')   gamePhase   = p.gamePhase;
    if(typeof p.gameMode==='string')    gameMode    = p.gameMode;
    if(typeof p.pendingEnterSF==='boolean') pendingEnterSF = p.pendingEnterSF;
    if(typeof p.voileUnlocked==='boolean')  voileUnlocked  = p.voileUnlocked;
    if(typeof p.crisisStreak==='number')    crisisStreak   = p.crisisStreak;
    if(typeof p.activeDeck==='string')      activeDeck     = p.activeDeck;
    if(typeof p.guideMode==='boolean')      guideMode      = p.guideMode;
    if(typeof p.marxView==='boolean')       marxView       = p.marxView;
    if(typeof p.cargo==='string')       MiniCircuit.cargo = p.cargo;
    if(typeof p.niveauVille==='number') CityGrowth.level  = p.niveauVille;
    // NB : on ne touche PAS à PlayerDistrict.marked ni au chemin reveal().
    // Ces deux-là s'auto-gardent sur leur drapeau ET ajoutent de la géométrie :
    // poser le drapeau à la main les rendrait inertes (aucun anneau, aucun
    // district visible). Le drapeau sauvegardé est une INTENTION, honorée
    // dans resynchroniser() en appelant la méthode elle-même.
    if(p.coach){
      if(typeof p.coach.active==='boolean')   TutorialCoach.active   = p.coach.active;
      if(typeof p.coach.hasMoved==='boolean') TutorialCoach.hasMoved = p.coach.hasMoved;
      if(typeof p.coach.tourKey==='string')   TutorialCoach.tourKey  = p.coach.tourKey;
      if(typeof p.coach.tourIndex==='number') TutorialCoach.tourIndex= p.coach.tourIndex;
    }
    // M9 — l'heure reprend où elle était, MAIS le lever d'ouverture est
    // considéré comme joué : reprendre une partie ne rejoue pas l'aube.
    if(typeof p.timeOfDay==='number'){ timeOfDay = p.timeOfDay; dawnIntroDone = true; }

    // 4. séquences cinéma — avant la resynchro, pour que le tick suivant
    //    parte de la bonne mémoire de seuil.
    if(typeof CinemaSequences!=='undefined' && CinemaSequences.restaurer)
      CinemaSequences.restaurer(d.cinema);

    // 5. véhicule.
    if(d.vehicule && Vehicle && Vehicle.pos){
      Vehicle.pos.set(d.vehicule.x, d.vehicule.y||0, d.vehicule.z);
      if(typeof d.vehicule.cap==='number') Vehicle.heading = d.vehicule.cap;
      Vehicle.speed = 0;
    }

    this.resynchroniser(p);
    return true;
  },

  /* Reconstruit le monde et l'interface depuis l'état restauré. C'est la
     même séquence que le jeu exécute après une action (applyUpgrade) et
     après un cycle (CompetitionSystem) — pas un chemin parallèle. */
  resynchroniser(p){
    p = p || {};
    // --- monde : bâti, stade historique, décor, ville ---
    recomputeProduction();
    updateBuildings();
    refreshNiveauVille();
    updateEnvironmentByStage();
    updateVilleBadge();
    updateZoneVisibility();
    updateConsequences();
    updateQuartier(0);
    if(typeof refreshPlayerPlant==='function') refreshPlayerPlant();

    // Districts concurrents : on pose le drapeau (beaucoup de règles de jeu
    // le lisent) puis on rend les groupes visibles — c'est tout le travail
    // visuel de reveal(), sans re-narrer l'événement au joueur.
    if(p.concurrentsReveles){
      CompetitorWorld.revealed = true;
      for(const c of CompetitorWorld.firms()) if(c._group) c._group.visible = true;
    }
    // mark() est protégée par son propre drapeau : sûre à appeler, elle ne
    // reposera pas les anneaux si la géométrie est déjà là.
    if(p.quartierMarque) PlayerDistrict.mark();
    PlayerDistrict.refreshHousing();
    CompetitorWorld.refreshVisuals();
    CompetitorWorld.renderRanking();
    CityGrowth.rebuild();

    // --- interface ---
    // La MISE EN SCÈNE d'abord : c'est elle qui montre le panneau de la
    // formation sociale (ou de la Commune). Sans elle, une partie reprise
    // dans ces modes voyait son panneau rempli mais laissé en display:none,
    // donc le bouton « Lancer le cycle productif » hors d'atteinte — et la
    // partie bloquée pour de bon.
    stageMode();
    // Le tableau social est de la GÉOMÉTRIE : il n'existe que dans ces deux
    // modes, il se garde tout seul dessus, et il se reconstruit à neuf.
    if(typeof buildSocialTableau==='function') buildSocialTableau();
    updateHUD(); updateMarx(); renderLeviers();
    renderQuest(); renderCircuitBar(); moveTargetMarker();
    renderHistLog();
    // Appel INCONDITIONNEL : la fonction dispatche elle-même vers le
    // panneau de la Commune et sort si l'on n'est dans aucun des deux modes.
    // Gardée sur `socialFormation`, elle laissait une reprise en Commune
    // devant un panneau vide.
    renderFormationPanel();
    const body=document.getElementById('log-body');
    if(body && journalEntries.length){
      const e=journalEntries[0];
      body.innerHTML=`<p${e.col?` style="color:${e.col}"`:''}>${e.html}</p>`;
    }
    if(document.getElementById('journal').classList.contains('on')) renderJournalModal();
    if(typeof tutorialCoachRefresh==='function') tutorialCoachRefresh(true);
  },

  /* --------------------------- INTERFACE -------------------------- */
  // Où en est la partie — la ligne de titre d'une carte d'accueil.
  ou(d){
    const a=(d&&d.apercu)||{};
    if(a.phase==='precapital')      return 'Phase 0 — le capital dort';
    if(a.phase==='socialFormation') return `Formation sociale — cycle ${a.cycle}`;
    return `Cycle ${a.cycle}`;
  },
  quand(d){
    try{ return new Date(d.date).toLocaleString('fr-FR',
      {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; }
  },
  // Nom de la partie : celui du joueur, ou un repli neutre s'il n'en a pas
  // voulu. Toujours restitué en texte, jamais interpolé dans du HTML.
  nom(d, i){
    const t = nettoieTitre(d && d.apercu && d.apercu.titre);
    return t || `Partie ${(i==null?0:i)+1}`;
  },
  /* Renomme SANS toucher au reste de la sauvegarde : on relit, on remplace
     le seul champ titre, on réécrit. Renommer ne doit pas devenir une
     occasion de réécrire une partie avec l'état courant du moteur. */
  renommer(i, titre){
    const d = this.lire(i); if(!d) return false;
    d.apercu = d.apercu || {};
    d.apercu.titre = nettoieTitre(titre);
    const s = this._store(); if(!s) return false;
    try{ s.setItem(saveKeyFor(i), JSON.stringify(d)); }
    catch(err){ this.lastError = err && err.message || String(err); return false; }
    if(i === slotActif) titrePartie = d.apercu.titre;
    return true;
  },
  // Étiquette compacte, pour le panneau ⚙ Paramètres.
  etiquette(d){
    if(!d) return 'aucune partie sauvegardée';
    const q=this.quand(d);
    return `${this.ou(d)} · ${(d.apercu||{}).argent} £${q?` — ${q}`:''}`;
  },
};

/* =====================================================================
   M9 — ÉCRAN D'ACCUEIL.

   Il s'ouvre après le préchargement, PAR-DESSUS le monde déjà construit :
   le joueur voit le paysage s'éveiller derrière le panneau pendant qu'il
   choisit. Trois emplacements, pas un de plus — la contrainte est visible
   plutôt que subie : pour ouvrir une quatrième partie, il faut en effacer
   une, et l'accueil le dit.

   L'accueil est le SEUL point d'entrée : c'est lui qui lance l'intro
   cinéma (nouvelle partie) ou la restauration (reprise). init() ne
   démarre plus le jeu tout seul.
   ===================================================================== */
let accueilOuvert = false;

const Accueil = {
  ouvrir(){
    accueilOuvert = true;
    document.body.classList.add('accueil-open');
    const el=document.getElementById('accueil'); if(el) el.classList.remove('hidden');
    this.rendre();
  },
  fermer(){
    accueilOuvert = false;
    document.body.classList.remove('accueil-open');
    const el=document.getElementById('accueil'); if(el) el.classList.add('hidden');
  },

  rendre(){
    const grille=document.getElementById('accueil-slots'); if(!grille) return;
    const note=document.getElementById('accueil-note');
    if(!SaveGame.disponible()){
      grille.innerHTML='';
      if(note) note.textContent='Ce navigateur n’autorise pas la sauvegarde locale : '
        + 'tu peux jouer, mais la progression ne sera pas conservée.';
      const seul=document.createElement('button');
      seul.className='ac-go'; seul.textContent='Commencer sans sauvegarde ▸';
      seul.addEventListener('click',()=>this.nouvelle(null));
      grille.appendChild(seul);
      return;
    }
    const parties=SaveGame.emplacements();
    const libres=SaveGame.placesLibres();
    if(note) note.textContent = libres>0
      ? `${libres} emplacement${libres>1?'s':''} libre${libres>1?'s':''} sur ${SAVE_SLOTS}.`
      : `Les ${SAVE_SLOTS} emplacements sont occupés. Efface une partie pour en commencer une nouvelle.`;

    grille.innerHTML='';
    parties.forEach((d,i)=>grille.appendChild(this.carte(d,i)));
  },

  carte(d,i){
    const c=document.createElement('div');
    c.className='ac-slot'+(d?'':' vide');
    const num=`<div class="ac-num">Emplacement ${i+1}</div>`;
    if(!d){
      // Occupé mais illisible : on le dit, et on n'offre QUE l'effacement.
      // Proposer « Nouvelle partie » ici écraserait en silence une partie
      // que le joueur n'a pas décidé de perdre.
      if(SaveGame.illisible(i)){
        c.className='ac-slot abime';
        c.innerHTML=`${num}<div class="ac-ou">Sauvegarde illisible</div>
          <p class="ac-abime">Cette partie a été écrite par une autre version du jeu,
          ou son contenu est abîmé. Elle ne peut pas être reprise.</p>`;
        const sup=document.createElement('button');
        sup.className='ac-act danger'; sup.textContent='Effacer';
        sup.addEventListener('click',()=>{
          if(sup.dataset.armed!=='1'){
            sup.dataset.armed='1'; sup.textContent='Confirmer ?';
            setTimeout(()=>{ if(sup.dataset.armed==='1'){ sup.dataset.armed='0'; sup.textContent='Effacer'; } },4000);
            return;
          }
          SaveGame.effacer(i); this.rendre();
        });
        c.appendChild(sup);
        return c;
      }
      // Emplacement libre : le joueur nomme sa partie avant de la commencer.
      // Le champ est présent d'emblée plutôt que caché derrière un clic —
      // il se voit, et rester vide reste parfaitement valable.
      c.innerHTML=`${num}<div class="ac-empty">Libre</div>`;
      const champ=document.createElement('input');
      champ.type='text'; champ.className='ac-nom'; champ.maxLength=TITRE_MAX;
      champ.placeholder=`Partie ${i+1}`;
      champ.setAttribute('aria-label',`Nom de la partie — emplacement ${i+1}`);
      const b=document.createElement('button');
      b.className='ac-act primaire'; b.textContent='Nouvelle partie';
      const lancer=()=>this.nouvelle(i, champ.value);
      b.addEventListener('click',lancer);
      champ.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); lancer(); } });
      c.appendChild(champ); c.appendChild(b);
      return c;
    }
    const a=d.apercu||{};
    // Le titre est du texte SAISI PAR LE JOUEUR : il n'entre jamais dans
    // une interpolation HTML. On monte la coquille, puis on pose le nom
    // par textContent.
    c.innerHTML=`${num}
      <h2 class="ac-titre"></h2>
      <div class="ac-ou">${SaveGame.ou(d)}</div>
      <dl class="ac-stats">
        <div><dt>Capital</dt><dd>${a.argent} £</dd></div>
        <div><dt>Stade</dt><dd>${AGES[(a.age||1)-1]||'Atelier'}</dd></div>
      </dl>
      <div class="ac-pied"><span class="ac-date">${SaveGame.quand(d)}</span></div>`;
    const hTitre=c.querySelector('.ac-titre');
    hTitre.textContent=SaveGame.nom(d, i);

    // Renommer : le titre bascule en champ de saisie sur place.
    const btnNom=document.createElement('button');
    btnNom.type='button'; btnNom.className='ac-ren'; btnNom.textContent='Renommer';
    btnNom.addEventListener('click',()=>{
      const champ=document.createElement('input');
      champ.type='text'; champ.className='ac-nom'; champ.maxLength=TITRE_MAX;
      champ.value=nettoieTitre(a.titre); champ.placeholder=`Partie ${i+1}`;
      champ.setAttribute('aria-label',`Renommer la partie — emplacement ${i+1}`);
      hTitre.replaceWith(champ); btnNom.remove(); champ.focus(); champ.select();
      let clos=false;
      const valider=()=>{ if(clos) return; clos=true;
        SaveGame.renommer(i, champ.value); this.rendre(); };
      champ.addEventListener('keydown',e=>{
        if(e.key==='Enter'){ e.preventDefault(); valider(); }
        if(e.key==='Escape'){ clos=true; this.rendre(); }   // abandon : on ne garde rien
      });
      champ.addEventListener('blur',valider);
    });
    c.querySelector('.ac-pied').appendChild(btnNom);

    const row=document.createElement('div'); row.className='ac-row';
    const rep=document.createElement('button');
    rep.className='ac-act primaire'; rep.textContent='Reprendre';
    rep.addEventListener('click',()=>this.reprendre(i));
    const sup=document.createElement('button');
    sup.className='ac-act danger'; sup.textContent='Effacer';
    sup.addEventListener('click',()=>{
      // Irréversible : on exige une seconde intention explicite, et on la
      // désarme toute seule pour qu'un clic oublié ne reste pas armé.
      if(sup.dataset.armed!=='1'){
        sup.dataset.armed='1'; sup.textContent='Confirmer ?';
        setTimeout(()=>{ if(sup.dataset.armed==='1'){ sup.dataset.armed='0'; sup.textContent='Effacer'; } },4000);
        return;
      }
      SaveGame.effacer(i); this.rendre();
    });
    row.appendChild(rep); row.appendChild(sup);
    c.appendChild(row);
    return c;
  },

  /* --- nouvelle partie : l'intro cinéma joue, puis le jeu commence --- */
  nouvelle(i, titre){
    slotActif = i;
    titrePartie = nettoieTitre(titre);
    this.fermer();
    // L'intro joue, puis le prologue dit qui l'on est. Si l'intro ne peut pas
    // jouer (déjà vue dans cette session), le prologue vient tout de suite.
    const prologue=()=>{ showConcept(PROLOGUE_SCREEN); tutorialCoachRefresh(true); };
    if(!CinemaSequences.playIntro(prologue)) prologue();
    startGame({handoff:true});
    SaveGame.autosave();      // l'emplacement est réservé dès le premier pas
    refreshSaveUI();
  },

  /* --- reprise : pas d'intro cinéma, on rend la main tout de suite --- */
  reprendre(i){
    const d=SaveGame.lire(i);
    if(!d){ this.rendre(); return; }
    slotActif = i;
    this.fermer();
    startGame({handoff:true, resume:true});
    if(!SaveGame.restaurer(d)){
      // Sauvegarde illisible : on ne laisse pas le joueur dans un état
      // à moitié restauré — retour à l'accueil, l'emplacement reste là.
      this.ouvrir();
      return;
    }
    ['journal','guide','concept','greve','upgrade','cards','report','zoneact','cycleplay','circuit-info']
      .forEach(id=>{ const e=document.getElementById(id); if(e) e.classList.remove('on'); });
    refreshModalMode();
    pushLog('Partie','Partie reprise là où tu l’avais laissée.','plain');
    refreshSaveUI();
  },
};

/* Panneau ⚙ Paramètres : état de l'emplacement en cours + retour à l'accueil. */
function refreshSaveUI(){
  const lab = document.getElementById('save-status');
  const btnSave = document.getElementById('save-now');
  if(lab){
    if(!SaveGame.disponible())      lab.textContent='sauvegarde indisponible dans ce navigateur';
    else if(slotActif==null)        lab.textContent='partie non enregistrée';
    else{
      const d=SaveGame.lire(slotActif);
      lab.textContent=`${SaveGame.nom(d, slotActif)} — ${SaveGame.etiquette(d)}`;
    }
  }
  if(btnSave) btnSave.disabled = (slotActif==null) || !SaveGame.disponible();
}
function sauvegarderPartie(){
  const r = SaveGame.ecrire();
  refreshSaveUI();
  if(r.ok) pushLog('Partie','Progression sauvegardée.','plain');
  else     pushLog('Partie',`Sauvegarde impossible (${r.erreur}).`,'warn');
  return r.ok;
}
(function wireSaveUI(){
  const b=(id,fn)=>{ const e=document.getElementById(id); if(e) e.addEventListener('click',fn); };
  b('save-now', ()=>sauvegarderPartie());
  b('save-home',()=>{
    // Retour à l'accueil : on sauvegarde puis on recharge. Le rechargement
    // est délibéré — c'est déjà la façon dont le jeu se remet à zéro
    // (endGame → location.reload) et il évite toute une classe de bugs de
    // réinitialisation partielle entre deux parties.
    SaveGame.ecrire();
    location.reload();
  });
  refreshSaveUI();
})();

let _coachTick=0;
function loop(){
  requestAnimationFrame(loop);
  const rawDt=Math.min(0.05,clock.getDelta()); t+=rawDt;
  // M-Cinéma — pendant une séquence : le temps de simulation est ralenti
  //   (timeScale par défaut 0.35). CinemaMode gère le LISSAGE entrée/sortie
  //   du timeScale (lerp 4 Hz pendant active + 6 Hz pendant ~0.5 s après
  //   end()) — on lit donc getTimeScale() en permanence pour transitions
  //   parfaitement continues. rawDt préservé pour la caméra cinéma et
  //   les particules d'atmosphère.
  CinemaMode.update(rawDt);   // moteur cinéma (caméra + DoF + grain)
  if(typeof CinemaSequences !== 'undefined') CinemaSequences.tick(rawDt);
  const cinemaActive = (typeof CinemaMode!=='undefined') && CinemaMode.isActive();
  const tScale = (typeof CinemaMode!=='undefined') ? CinemaMode.getTimeScale() : 1;
  const dt = rawDt * tScale;
  _coachTick+=dt; if(_coachTick>0.35){ _coachTick=0; tutorialCoachRefresh(); }
  // Pendant le cinéma le chariot reste immobile (les inputs sont ignorés
  // par Vehicle.speed=0 et le timeScale réduit toute dérive éventuelle).
  // M9 — accueil ouvert : le chariot ne bouge pas. Le monde continue de
  // vivre derrière le panneau (soleil, fumées, oiseaux), mais rien de ce
  // que tape le joueur ne part dans une partie qu'il n'a pas encore choisie.
  Vehicle.update(dt, (cinemaActive||accueilOuvert) ? {fwd:false,back:false,left:false,right:false} : Input);
  CameraController.update();
  handleZones(dt);
  cooldownReal=Math.max(0,cooldownReal-dt);
  if(flashTimer>0){ flashTimer-=dt; document.getElementById('flash').style.opacity=Math.max(0,flashTimer); }
  // balise du prochain lieu
  if(targetMarker&&targetMarker.visible){
    targetMarker.userData.cone.position.y=16+Math.sin(t*2.4)*0.8;
    targetMarker.userData.cone.rotation.y=t*1.6;
    targetMarker.userData.beam.material.opacity=0.22+0.14*Math.sin(t*2.4);
  }
  updateGroundArrow();
  const prod=Math.min(1.7, state.heures/10);     // intensité de production -> fumée
  const risk=state.d.risqueCrise||0;             // spéculation -> bulles
  if(shouldRunHeavySceneEffects()){
    scene.traverse(o=>{
      if(o.userData&&o.userData.smoke){ o.position.y=15.5+Math.sin(t*1.5+o.position.x)*0.6*prod;
        o.material.opacity=Math.max(0.05,(0.25+Math.sin(t*2+o.position.x)*0.12)*prod); o.scale.setScalar(0.7+0.5*prod); }
      if(o.userData&&o.userData.bubble!==undefined){ const amp=0.25+risk*0.9;
        o.scale.setScalar((1+amp*Math.sin(t*1.2+o.userData.bubble*2))*(1+risk*0.6));
        o.material.opacity=0.5+0.3*Math.sin(t*1.2+o.userData.bubble*2); }
      if(o.userData&&o.userData.pulse){ o.scale.setScalar(0.8+0.4*Math.sin(t*4)); }
    });
  }
  CompetitorWorld.ambient(dt);        // v49 : flux des autres capitaux vers les marchés communs
  CompetitorWorld.updateCommuters(dt);// v53 : navetteurs quartier ouvrier -> chaque usine
  CityGrowth.updateRails(dt);         // v54 : wagon navette usines -> port
  WorldBeauty.update(dt);             // v56 : nuages, oiseaux, tangage des bateaux
  // M8 — rawDt et non dt : la course du soleil est une horloge du MONDE, pas
  // de la simulation. Avec dt elle subissait le timeScale du cinéma (×0.35),
  // et le lever d'ouverture n'avançait qu'au tiers pendant tout le trailer.
  DayCycle.update(rawDt);             // v57/M7 : avance timeOfDay + sun/moon via SunState
  updateQuartier(dt);                 // M-Quartier : niveaux d'extension du quartier ouvrier
  updateClassLighting(dt);            // M4 : sim → facteurs lissés (avant le rendu des vitres)
  updateWindowGlow();                 // v62 + M4 : fenêtres + lampes + cônes
  Atmosphere.update(dt);              // v58 : brume + position du soleil
  PuffTrains.update(dt);              // v63 : trains de bouffées des cheminées
  M_Polish.update(dt);                // M-Polish/A : sparks, motes, steam, fog
  M_Life.update(dt);                  // M-Polish/B : oiseaux V, chat, linge, fanions, fumées
  updateZoneSignsFade();              // M-Peaufinage/D : marqueurs £ discrets à proximité
  updateSkySmoke(dt);                 // M2 : fumée des cheminées lointaines (skyline)
  updateSkyAtmosphere(dt);            // M2 : nuages, godrays, voile doré
  _M6_updateWater();                  // M6 : vagues + reflets fanaux (ShaderMaterial)
  _M6_updateCranes();                 // M6 : pivot lent des grues du port
  _M_Mer_updateLighthouse();          // M-Mer/B : rotation faisceau, intensité jour/nuit
  _M_Mer_updateTraffic(dt);           // M-Mer/C : bateaux, sillages, fumée vapeur
  _M_Mer_updateFauna(dt);             // M-Mer/D : crabes, mouettes, bouées, poissons
  _M_Mer_updateShoreFoam();           // M-Mer/correctif-rivage : ressac doux
  AmbientSound.update(dt);            // v58 : mixage par proximité
  updateLwTweens();
  updateLivingWorld(dt);
  PeuplePop.update(dt);               // M-Peuple : effectifs ∝ état réel
  Peuple.update(dt);                  // M-Peuple : figures de classe animées
  updateInteractiveProps(dt);
  updateFx();
  updateFloaters();
  if(pendingEnterSF && !anyModalOpen()){ pendingEnterSF=false; enterSocialFormation(); }
  // M1 — uTime du GradePass (grain animé). Mis à jour même si bypassé : coût nul.
  if(gradePass) gradePass.uniforms.uTime.value = t;
  if(composer && !COMPOSER_BYPASS) composer.render(); else renderer.render(scene,camera);
  // M1 — métriques #qa (lissées, mises à jour ~10 Hz).
  qaSampleFrame(dt);
}

// M0 — init() est appelé depuis src/main.js après le préchargement des assets.

/* ----------------------------------------------------------------------
   Exports : ré-exposés par les facades src/{world,vehicle,camera,input,
   ui,sim,fx}/ pour respecter le découpage annoncé. Les variables `let`
   exportées (scene, renderer, camera, composer) sont des "live bindings"
   ES — les modules clients lisent toujours la valeur courante.
   ---------------------------------------------------------------------- */
export {
  THREE,
  // World
  buildWorld, defineZone, zones, zoneGroups, obstacles, HALF,
  // Boucle de rendu
  scene, renderer, camera, composer, bloomPass,
  // Acteurs principaux
  Vehicle, CameraController, Input, KEYMAP,
  // Simulation (stub)
  SimulationState, ProductionSystem, CompetitionSystem, MarketSystem,
  LaborSystem, CrisisSystem, CreditSystem, StateSystem,
  CapitalCircuit, EventLog, MiniCircuit, runCycle, state, log, circuit,
  // UI
  updateHUD, updateMarx, renderLeviers, renderCircuitBar, renderQuest,
};
