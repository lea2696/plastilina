# Validación mínima con webcam real

URL activa verificada: https://masa-web-demo.vercel.app. Es una demo experimental, no v1; todavía no se hizo prueba humana. No grabar ni compartir video, fotos o landmarks. Este protocolo se usa sobre la URL HTTPS pública del proyecto dedicado después de verificar sus recursos.

1. En Chrome o Edge desktop, abrir la URL verificada, aceptar cámara y mostrar una mano durante la calibración. Confirmar que se ven sus 21 puntos y que la respuesta sigue el movimiento sin tirones peligrosos. Anotar navegador/versión, sistema, GPU informada por el diagnóstico y resolución de pantalla, sin seriales ni datos privados.
2. Mostrar dos manos, cruzarlas y ocultar una. Confirmar que no se intercambian agarres ni una mano perdida sigue moviendo masa. Recalibrar si el mapeo es incómodo.
3. Presionar con dedo y palma, amasar, agarrar cerca de superficie, estirar, levantar y soltar; confirmar que la masa se hunde/persiste, cae y no salta o atraviesa la mesa. Usar el botón de pausa/cámara apagada cuando se necesite.
4. Mantener 10 minutos de uso activo; observar diagnóstico de FPS, frame p95/p99, antigüedad de landmarks, contacto y calidad. Si el equipo no tiene GPU WebGL compatible, registrar no disponible en vez de inferir rendimiento.
5. Comprobar pote/introducción, sonido de contacto, silencio sin contacto y mute. Informar si el audio o postura resultan molestos, si la solapa/cavidad del pliegue es visible en uso normal o si se produce pérdida de tracking.
6. Apagar cámara y verificar que el indicador del navegador se apaga; recargar y comprobar que no se reactiva sola. Si se inspecciona la red, no deben salir video/landmarks ni POST de producto.

Registrar el resultado en docs/QA_REPORT.md: aprobado, falló con reproducción mínima, o no disponible. Distinguir FPS de la prueba humana del benchmark sintético. No publicar v1 como validada antes de estos resultados.
