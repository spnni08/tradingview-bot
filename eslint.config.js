// Bewusst SEHR permissive Basis-Lint-Config (CI-Gate, kein Lint-Aufräumen).
//
// Ziel laut Task: nur OFFENSICHTLICHE Fehler fangen (doppelte Object-Keys,
// unerreichbarer Code, versehentliche Zuweisung in if(), …) — KEIN großes
// Aufräumen von Stil/Unused-Vars auf der 8k-Zeilen-worker.js. Daher wird
// `eslint:recommended` NICHT geladen; nur eine kleine Liste echter Bug-Muster
// steht auf "error". Stil-/Unused-Regeln bleiben aus, no-undef ist aus, weil
// die Worker-/Browser-/Node-Laufzeit viele globale APIs bereitstellt.
//
// Erweitern später: einzelne Regeln gezielt von "off" auf "warn"/"error"
// hochziehen, nicht pauschal recommended aktivieren.

export default [
  {
    files: ['worker.js', 'src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Echte Bug-Muster → hart blocken:
      'no-dupe-keys': 'error',        // doppelte Keys im selben Objekt-Literal
      'no-dupe-args': 'error',        // doppelte Parameternamen
      'no-func-assign': 'error',      // Funktionsdeklaration überschrieben
      'no-unreachable': 'error',      // Code nach return/throw
      'no-cond-assign': ['error', 'except-parens'], // if (x = y) ohne Klammern
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'getter-return': 'error',

      // Bewusst AUS (kein Cleanup-Auftrag, viele Laufzeit-Globals):
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
  {
    // Generierte/irrelevante Pfade nie linten.
    ignores: [
      'frontend/**', 'electron/**', 'public/**', 'score-optimizer/**',
      'backtest/**', 'node_modules/**', '**/*.snapshot',
    ],
  },
];
