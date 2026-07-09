# Estado del proyecto — Autoescuela Exit

_Última actualización: 9 jul 2026_

## Resumen

Sistema **completo, desplegado y en funcionamiento**. CRM web + bot de
WhatsApp + base de datos en la nube, sincronizados en tiempo real.

| Componente | URL / ubicación | Estado |
|---|---|---|
| CRM | https://bervanai.github.io/autoescuela-crm/ | ✅ En producción |
| Bot | https://autoescuela-bot-production.up.railway.app | ✅ En producción |
| Base de datos | Supabase (proyecto `vxpavrtjgvrxqimsemku`, París) | ✅ Operativa |

## Funcionalidades terminadas

**CRM (web + móvil):**
- ✅ Login con contraseña por usuario (hash bcrypt en la nube)
- ✅ Alumnos: bono, tasas DGT, examen con flujo APTO/NO APTO
- ✅ Horario semanal por profesor, exportable a PDF
- ✅ Disponibilidad y bloqueo de horas por profesor
- ✅ Profesores, vehículos, estadísticas
- ✅ Sincronización en tiempo real con la nube (subida ~1,5 s, bajada cada 15 s)
- ✅ Multi-dispositivo: cualquier ordenador/móvil ve los mismos datos
- ✅ Diseño adaptado a móvil (menú hamburguesa, tablas con scroll)
- ✅ Simulador del bot integrado (demo sin depender de WhatsApp)

**Bot de WhatsApp:**
- ✅ Campaña automática: martes 9:00 a todos; mié-jue solo a los que no
  han reservado; cierre jueves 23:59
- ✅ Reserva desde el lunes de la semana siguiente, en orden
- ✅ Atajo numérico: "3" reserva 3 clases repartidas de una vez
- ✅ Consulta de disponibilidad: "¿el martes a las 10 está libre?"
- ✅ Consultar clases: "¿qué clases tengo?"
- ✅ Cancelar: "cancelar" → lista numerada → avisa al profesor
- ✅ Recordatorio automático 48 h antes
- ✅ Respeta disponibilidad, horas bloqueadas y días de examen
- ✅ Se presenta como "Autoescuela Exit" (nombre leído de la BD)

**Seguridad:**
- ✅ Webhook con validación de firma de Twilio
- ✅ Tablas protegidas con RLS; acceso solo por RPC con sesión de token
- ✅ Contraseñas con hash bcrypt
- ✅ Sin API que exponga datos personales
- ✅ Campañas masivas protegidas con clave (`BOT_API_KEY`)

## Pendiente — tareas del propietario (no de código)

### Antes de presentar
1. **Rotar claves** expuestas durante el desarrollo: `service_role` de
   Supabase y `Auth Token` de Twilio → regenerar y actualizar en Railway.
2. **Upgrade de la cuenta Twilio** (añadir tarjeta) → elimina el texto en
   inglés "Sent from your Twilio trial account". Sin cuota, solo mensajes.
3. **Ensayar** con `GUION_DEMO.md`.

### Para producción con un cliente real
4. **Número de WhatsApp propio** con nombre y logo de la autoescuela
   (Meta Business + Twilio, 1-2 semanas de aprobación). Mientras tanto,
   el sandbox sirve para demos.
5. Cargar datos reales (profesores, alumnos, disponibilidad).

## Mejoras opcionales de futuro (nada bloquea)

- Autenticar `/api/send-booking` y `/api/send-reminder` con el token de
  sesión (hoy solo mensajean al teléfono propio del alumno; riesgo bajo).
- Tiempo real bidireccional al segundo (Supabase Realtime) en vez de
  polling cada 15 s.
- Alta automática de nuevas autoescuelas (multi-tenant self-service).
- Dominio propio y copias de seguridad programadas.

## Notas técnicas

- Los avisos del linter de Supabase sobre funciones `SECURITY DEFINER`
  ejecutables por `anon` son **intencionados**: son las RPC que autentican
  al CRM por token (lo validan internamente). No son vulnerabilidades.
- Sincronización de clases: granular por id (`crm_sync_slots`) para que el
  auto-guardado del CRM nunca borre una reserva que el bot acaba de crear.
