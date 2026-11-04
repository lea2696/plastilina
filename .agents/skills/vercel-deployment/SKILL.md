---
name: vercel-deployment
description: Publicar build estático de Masa en proyecto Vercel nuevo y autorizado, con preview y smoke real.
---
# Cuándo
Preparar o ejecutar preview/producción, revisar configuración y recursos remotos.
# Entradas y procedimiento
Leer PRD 10 y 14, docs/DEPLOYMENT.md y .vercel/project.json si existe. Correr verify/build y auditar dist por secretos, assets, licencias y headers. Identificar ámbito personal inequívoco; no usar equipo de trabajo por sesión abierta. Crear/vincular proyecto nuevo dedicado. Preview primero: abrir URL, comprobar HTTP, modelo/WASM, consola, controles y modo sintético. Producción solo si gates P0 técnicos pasan; webcam no validada implica etiqueta experimental. Registrar URL y build reales.
# Comandos/evidencia
pnpm verify; pnpm build; vercel whoami; vercel deploy (flags actuales); inspección HTTP. Anotar destino y resultados en docs/DEPLOYMENT.md y docs/QA_REPORT.md.
# Fallos frecuentes
Heredar .vercel de otro proyecto; publicar tras build fallido; inventar URL; confundir password de acceso con fallo de app; desactivar seguridad; poner secretos en frontend. En un proyecto Vercel vacío, CLI 59.25.2 promovió a producción tanto `vercel deploy --prebuilt` como `--target=preview`; los deployments se eliminaron. Ver docs/DEPLOYMENT.md y no repetir el primer deploy hasta garantizar preview por otro mecanismo o recibir autorización específica para cambiar el orden.
