---
name: visual-audio-quality
description: Construir escena, pote, manos y audio reactivo con recursos verificables y revisión visual.
---
# Cuándo
Cambiar estudio, material, intro, luces, manos, sonido o assets.
# Entradas y procedimiento
Leer PRD 3.3 y 6. Mantener masa y contacto visibles; pote genérico procedural, intro omisible y reduced-motion. Sonido Web Audio tras gesto explícito, únicamente por contacto, con voces/envolventes limitadas y mute inmediato. Recursos externos solo con licencia separada y SHA-256; preferir procedural cuando convenga. Capturar escena determinista y abrir PNG para inspección visual, no aceptar archivo sin verla.
# Comandos/evidencia
pnpm assets:prepare; pnpm assets:verify; pnpm test:e2e; pnpm build. Actualizar assets/manifest.json, docs/THIRD_PARTY_NOTICES.md y docs/QA_REPORT.md.
# Fallos frecuentes
Marca comercial; textura que patina; audio en el aire o clipping; animación que sustituye física; assets provisionales anunciados como finales.
