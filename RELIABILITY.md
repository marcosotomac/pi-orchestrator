# Fiabilidad: pruebas y límites

## Regresión paralela

`npm test` conserva paralelismo. Los watchdogs de fixtures Codex/Claude admiten 15 segundos de tiempo de pared en vez de 3: bajo contención el arranque no es una medición de latencia del protocolo. No se amplían los plazos de producción. Los tests de crash reintentan únicamente censos **no disponibles** durante un plazo acotado; agotarlo falla. Una observación disponible que contradiga la supervivencia falla inmediatamente. La producción conserva su semántica conservadora: desconocido nunca acredita limpieza.

Tres ejecuciones paralelas consecutivas pasaron 168 pruebas: `artifacts/parallel-reliability-{1,2,3}.log`. La suite incluye desconexión MCP wait, crash SIGKILL/archivo no adoptable/reinicio explícito y 2.000 tareas simuladas en 20 coordinadores, con fallos, cola, cancelación y shutdown. No es una prueba de horas ni evidencia de estabilidad ilimitada de agentes nativos. Los fallos anteriores no se borraron.

## Diagnósticos

Las tareas fallidas exponen `diagnostic.category`, `recovery` y `automaticRetry:false`. Categorías: authentication/network/quota/protocol/cleanup/unknown. Son recomendaciones, no autoridad ni garantía de causa: errores externos ambiguos permanecen unknown. Antigravity clasifica sus rechazos RPC sin publicar el cuerpo del proveedor; mensajes y códigos disponibles pueden orientar la categoría, no provocar recuperación automática. Nunca cambia cuentas, importa credenciales, relaja validaciones ni repite trabajo por sí solo.

## Prueba humana de permisos Antigravity

**Pendiente de ejecución humana.** Consume cuota. Utiliza un workspace temporal sin secretos. No cargues simultáneamente la extensión normal y el arnés; evita paquetes personales que ya la carguen.

Desde la raíz de este repositorio:

```bash
ROOT="$HOME/Desktop/pi-orchestrator"
WORK="$(mktemp -d /tmp/orch-human.XXXXXX)"
cd "$WORK"
mkdir artifacts
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 \
PI_ORCHESTRATOR_ANTIGRAVITY_ACP="$ROOT/.runtimes/antigravity/1.4.5/agy_acp_server.par" \
PI_ORCHESTRATOR_ANTIGRAVITY_PROFILE="$ROOT/.runtimes/antigravity/profile" \
pi --extension "$ROOT/scripts/human-permissions-extension.ts"
```

En Pi, solicita una operación inocua pero que requiera permiso nativo:

```text
/orch start antigravity Usa una herramienta nativa para ejecutar únicamente printf ORCH_PERMISSION_TEST. Si requiere autorización, solicítala. No escribas archivos, no leas credenciales, no uses red ni delegues. No simules que ejecutaste el comando.
```

1. Inspecciona que el diálogo identifica Antigravity/tarea y describe **solo** la operación esperada. Deniega si los detalles no permiten verificarla.
2. Primer intento: deniega. Comprueba que no se anuncia éxito ni ejecución autorizada.
3. Segundo intento: aprueba una sola vez únicamente si los detalles son correctos. Comprueba actividad nativa y resultado; una respuesta textual del modelo no acredita ejecución por sí sola.
4. Tercer intento: cancela la tarea mientras espera o deja expirar el diálogo. No debe aceptar una respuesta posterior ni publicar resultado tardío.
5. Sal de Pi normalmente para registrar el cierre. El arnés escribe `artifacts/human-permissions-*/report.json` **dentro del workspace temporal**, solo tipo de diálogo/si hubo respuesta/aborto/estados/salida observada, no argumentos ni credenciales.

Si el motor no solicita permiso, el caso es **inconcluso**, no aprobado. El registro de una respuesta no prueba éxito de la operación; exige revisión humana de la actividad nativa. No automatices confirmaciones para convertir esta prueba en verde. El arnés no cambia permisos globales ni aprueba operaciones por sí mismo.
