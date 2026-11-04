# Masa — instrucciones del repositorio

Objetivo: implementar el PRD completo, priorizando contacto, plasticidad y privacidad frente al acabado. Leer en orden docs/PRD.md, docs/PROGRESS.md, docs/DECISIONS.md y las skills de .agents/skills/ pertinentes. El PRD es fuente de verdad; no rebajar P0 para obtener tests verdes.

Base: React/TypeScript/Vite; contratos en src/shared; tracking, interacción, simulación, rendering, audio y UI separados. HandFrame y replays comparten entrada. Timestamps en ms monotónicos; mundo en metros con mesa y=0. No estado React por partícula ni colas de inferencia/pasos sin límite.

Comandos reales: pnpm install --frozen-lockfile; pnpm assets:prepare; pnpm assets:verify; pnpm dev; pnpm typecheck; pnpm lint; pnpm test; pnpm test:e2e; pnpm test:physics; pnpm test:topology; pnpm test:stability; pnpm test:audio; pnpm benchmark; pnpm build; pnpm audit:dist; pnpm preview; pnpm verify. Consultar package.json antes de asumir que un comando existe.

Invariantes: cámara/landmarks locales y sin persistencia; datos viejos no aplican fuerzas; contacto de superficie, no atracción remota; masa no atraviesa mesa; deformación persistente; volumen medido sobre superficie/ocupación, no suma de masa declarada. Marcar pruebas sintéticas, webcam real, GPU y prueba humana por separado.

No instalar componentes globales, desactivar protecciones, subir datos de cámara ni guardar secretos. Assets con hash/licencia en assets/manifest.json. No push. Vercel solo proyecto nuevo dedicado en ámbito personal/autorizado inequívoco; preview antes de producción y smoke remoto. No heredar .vercel a ciegas.

Actualizar docs/PROGRESS.md, docs/DECISIONS.md y docs/QA_REPORT.md tras cada fase. Al retomar, verificar Git, correr suites y seguir primera tarea pendiente; no regenerar avances.
