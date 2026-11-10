# Antigravity ACP (experimental)

Adaptador para el runtime ACP oficial de Antigravity.

[← README](../README.md)

## Antigravity ACP: instalación y autenticación propias

Se implementó un adaptador **experimental** para el runtime ACP oficial, no para `agy --print`. Siguiendo las referencias de T3/Orca, servidor y helper se instalan juntos, con versión, tamaño y SHA-256 fijados. El instalador actual solo está cualificado para **macOS arm64, versión 1.4.5**. Es software propietario de Google: [términos oficiales](https://antigravity.google/terms); no se redistribuye como código MIT del proyecto.

```sh
npm run antigravity:install  # descarga explícita; solo .runtimes/ dentro del proyecto
npm run antigravity:probe    # initialize, sin login ni llamadas de modelo
npm run antigravity:auth     # OAuth oficial; interacción explícita en navegador
npm run test:installer       # seis pruebas Python, sin red ni agentes

PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 \
  pi --extension "$HOME/Desktop/pi-orchestrator/src/extension.ts"
```

Dentro de Pi: `/orch engines` detecta el runtime sin iniciarlo ni crear estado; `/orch start antigravity INSTRUCCIÓN` crea una tarea. También puede seleccionarse `antigravity` en las herramientas de Pi y MCP. No se añade nada al PATH ni se modifica configuración global.

- Perfil dedicado: `.runtimes/antigravity/profile`, con `GEMINI_HOME` y almacenamiento administrado por el runtime. No se importan credenciales del IDE, CLI ni de Pi. El entorno del hijo excluye claves/configuración Google heredadas. Los archivos de autenticación son sensibles y están excluidos de Git.
- Se exige identidad/version compatible y MCP HTTP. Se usa modo ACP `default`. Por defecto solo se preaprueban una vez las cuatro herramientas del servidor MCP propio, con sesión y metadatos coincidentes; otras operaciones requieren permiso humano. Con autorización YOLO explícita por tarea, Pi aprueba automáticamente permisos de herramientas `allow_once`, sin cambiar el modo nativo ni guardar aprobaciones persistentes. Las preguntas genuinas no se contestan automáticamente. Escritura y terminal solicitados al cliente siguen sin estar implementados y fallan cerrados. Esto no es un sandbox completo del ordenador.
- Antigravity 1.4.5 puede enviar notificaciones (`usage_update`) antes de responder a `session/new`. Se guardan con tope (64 mensajes / 256 KiB) y se validan contra el ID de sesión al conocerlo; una de otra sesión sigue fallando cerrada. Antes de este arreglo, varias tareas de Antigravity en paralelo fallaban de forma intermitente con `Antigravity update has unknown session`.
- `_meta.antigravity.disabledTools = ["run_workflow"]` evita la escritura de un skill al crear sesión observada en esta familia de versiones. Los fixtures comprueban este parámetro; los cinco casos reales comprobaron su workspace intacto.
- Login realizado y `initialize` real comprobados con el runtime oficial. **Cinco casos reales aprobados:** lectura de marca impredecible; Antigravity → Codex, Antigravity → Claude y ambas inversas, con delegación MCP, resultado devuelto al padre, salida observada y journal cerrado. Evidencia: `artifacts/antigravity-verification.json`. Los dos primeros fallos por permisos se conservan.
- La primera matriz partía del servicio y del padre nativo. Posteriormente se comprobaron también la elección de Antigravity por el modelo principal de Pi y la cancelación nativa de árboles en cuatro direcciones; véase la validación ampliada siguiente. Los fixtures cubren además abort, protocolo y denegaciones.

Pruebas reales opt-in, **consumen cuota y no tienen tope monetario duro**:

```sh
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 npm run smoke:antigravity
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 npm run smoke:antigravity-nested -- antigravity codex
# También: antigravity claude, codex antigravity, claude antigravity
```

Para un runtime externo: `PI_ORCHESTRATOR_ANTIGRAVITY_ACP=/ruta/agy_acp_server.par`, con helper compatible al lado, y opcionalmente `PI_ORCHESTRATOR_ANTIGRAVITY_PROFILE=/perfil/privado`. Encontrar un binario no acredita autenticación ni compatibilidad. El login no se abre automáticamente al delegar: las credenciales vencidas deben renovarse explícitamente.
