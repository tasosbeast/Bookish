import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'frontend/dist/**',
      'src/generated/**',
      'coverage/**',
      'scripts/catalog-cache/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    files: ['frontend/**/*.{js,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: '19.2',
      },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      // Vite compiles JSX with the automatic runtime.
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      // Components do not declare PropTypes.
      'react/prop-types': 'off',
      // Pages load server data by setting state in effects. Rewriting that
      // pattern would change loading, cancellation, and draft behavior.
      // Warning mode still fails `npm run lint` under --max-warnings=0
      // (14 existing findings), so this stays off.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['frontend/public/sw.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
      },
    },
  },
];
