# Autoescuela Exit — CRM + Bot de WhatsApp

Sistema completo de gestión para autoescuelas: panel web de administración y
bot de WhatsApp que organiza las clases de los alumnos automáticamente,
sin llamadas ni papel.

## Qué hace

**El bot (WhatsApp):**
- Cada **martes a las 9:00** escribe a todos los alumnos activos para
  organizar las clases de la semana siguiente (empezando por el lunes)
- **Miércoles y jueves** persigue solo a quienes aún no han reservado;
  el plazo cierra el **jueves a las 23:59**
- El alumno responde `SÍ`/`NO`, un número (`3` = 3 clases repartidas en
  días distintos de una vez), o pregunta en lenguaje natural:
  *"¿el martes a las 10 está libre?"*, *"¿qué clases tengo?"*, *"cancelar"*
- Recordatorio automático **48h antes** de cada clase, con cancelación
  desde el propio chat (el profesor recibe el aviso al instante)
- Respeta la disponibilidad de cada profesor, las horas bloqueadas y los
  días de examen marcados en el CRM

**El CRM (web):**
- Alumnos (bono, tasas DGT, fecha de examen con flujo APTO/NO APTO),
  horario semanal por profesor (exportable a PDF), disponibilidad,
  profesores, vehículos, estadísticas
- Login con contraseña por usuario (admin y profesores); cada profesor
  ve solo lo suyo
- **Sincronización en tiempo real** con la nube: cada cambio se sube en
  ~1,5 s y el panel se refresca contra la base de datos cada 15 s
- Simulador del bot integrado (demo sin depender de WhatsApp)

## Arquitectura

```
GitHub Pages ──── CRM (index.html, React sin build) ───┐
                                                        ├── Supabase (Postgres + RLS)
Railway ───────── Bot (bot-server.js, Node/Express) ───┘
                        │
                     Twilio ──── WhatsApp de los alumnos
```

- **Fuente de verdad**: Supabase. El CRM accede mediante RPCs con sesiones
  por token (las tablas no son legibles con la clave pública); el bot usa
  la service key. Contraseñas con hash bcrypt.
- **Seguridad del bot**: webhook con validación de firma de Twilio; los
  disparadores de campaña requieren `BOT_API_KEY`; sin endpoints que
  expongan datos personales.

## Ficheros

| Fichero | Qué es |
|---|---|
| `index.html` | CRM completo (single-file React) |
| `bot-server.js` | Bot de WhatsApp + campañas + API mínima |
| `supabase_schema.sql` | Esquema de referencia de la base de datos |
| `SETUP.md` | Guía de despliegue paso a paso |
| `GUION_DEMO.md` | Guión de presentación comercial |
| `.env.example` | Variables de entorno del bot |

## Puesta en marcha

Ver **[SETUP.md](SETUP.md)**. Resumen: crear proyecto en Supabase y ejecutar
el esquema → desplegar el bot en Railway con las variables de `.env.example`
→ configurar el webhook en Twilio → abrir el CRM.

## Costes de infraestructura

~5 €/mes (Railway) + mensajes de WhatsApp (~5-12 €/mes por autoescuela con
50 alumnos). Supabase y GitHub Pages en capa gratuita.
