# Masa

Experimento web de masa 3D deformable sobre una mesa. La cámara se procesa localmente con MediaPipe Hand Landmarker; no hay backend de producto, cuentas ni guardado. La demo sin cámara usa landmarks sintéticos y está rotulada como tal.

Demo pública experimental: https://masa-web-demo.vercel.app. No equivale a una v1 validada; ver Estado.

## Desarrollo

Node 26 y pnpm 12.6.0 son las versiones probadas. `pnpm install --frozen-lockfile`, `pnpm assets:prepare`, `pnpm dev`. El visitante solo necesita un navegador desktop compatible, HTTPS y permiso de webcam.

Validación: `pnpm assets:verify`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:physics`, `pnpm test:topology`, `pnpm test:stability`, `pnpm test:audio`, `pnpm benchmark`, `pnpm build`, `pnpm audit:dist`, `pnpm test:e2e`, `pnpm verify`. Las E2E usan Chrome instalado y una cámara falsa de Chrome; no validan una webcam humana. `LONG_QA_SECONDS=600 pnpm exec playwright test tests/e2e/long-run.spec.ts` ejecuta la fixture integrada prolongada. `pnpm preview` sirve dist localmente para inspección.

## Estado

Consultar docs/PROGRESS.md y docs/QA_REPORT.md. Física XPBD 3D, dos manos sintéticas, worker MediaPipe, rendering, pote e interfaz están implementados, pero el gate AC-10 falla: el pliegue extremo deja cruces de superficie persistentes. El usuario confirmó tracking de manos con webcam real pero reportó manipulación y caída deficientes en la primera demo; esta iteración corrige mapeo y agarre, pendiente de que la pruebe. El modo oscuro es predeterminado y hay botón para modo claro. No confundir build/E2E sintética con v1 aprobada. Se conserva PRD.md original y docs/PRD.md como copia de fuente de verdad.

## Privacidad

El procesamiento de video ocurre en el navegador. Solo se sirven recursos estáticos desde el mismo origen; sin analítica ni peticiones de cámara/landmarks a servidores. «Apagar cámara» detiene tracks y worker. Recursos/licencias/hashes en assets/manifest.json y docs/THIRD_PARTY_NOTICES.md.
