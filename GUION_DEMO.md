# Guión de demo — Autoescuela Exit (CRM + Bot WhatsApp)

> Duración: 10-12 minutos. Necesitas: portátil con el CRM abierto y tu móvil
> con WhatsApp (unido al sandbox). Ensáyalo una vez antes.

## Preparación (la noche antes)

- [ ] Entrar al CRM y comprobar que carga: https://bervanai.github.io/autoescuela-crm/
- [ ] Comprobar el bot: `https://autoescuela-bot-production.up.railway.app/api/ping` → debe decir `"modo":"supabase"`
- [ ] Tener 1 alumno de prueba con TU móvil y el bot en verde
- [ ] Dejar 0-1 clases reservadas (que se vea el horario limpio)
- [ ] Configurar la disponibilidad del profesor con horas realistas
- [ ] Cargar el móvil 🔋 y abrir el chat de WhatsApp con el bot

## El guión

### 1. El problema (1 min)
"¿Cuánto tiempo pierde tu recepcionista cada semana llamando alumno por
alumno para cuadrar las clases? ¿Y cuántas clases se quedan vacías porque
alguien no avisó de que no venía?"

### 2. El CRM (3 min)
- Login con contraseña → **Dashboard**: alumnos, clases de hoy, tasas pendientes
- **Alumnos**: ficha completa — bono, tasas DGT, fecha de examen (enseñar el
  flujo APTO/NO APTO: cuando pasa el examen la fila se pone roja y pide decisión)
- **Horario**: vista semanal por profesor, exportable a PDF con un botón
- **Disponibilidad**: cada profesor marca sus horas; se guarda solo en la nube
- Frase clave: *"Todo lo que tocas se guarda en la nube en 1,5 segundos.
  Si se rompe el ordenador, no se pierde nada."*

### 3. La estrella: el bot (5 min) — EN DIRECTO con tu móvil
- Explicar el ciclo: *"Cada martes a las 9:00 el bot escribe él solo a todos
  los alumnos. Tienen hasta el jueves para organizar su semana. El miércoles
  y el jueves persigue únicamente a los que no han reservado."*
- Lanzar el mensaje (desde Alumnos → botón verde "Reserva" del alumno demo)
- **Enseñar el móvil** (o espejo de pantalla):
  1. Responder **3** → el bot reserva 3 clases repartidas y manda el resumen
  2. Con el CRM proyectado: **las clases aparecen solas en el Horario en ~15s** 🎩
  3. Preguntar *"¿el viernes a las 11 está libre?"* → responde ✅/❌ al momento
  4. Escribir **cancelar** → elegir una → *"el profesor acaba de recibir el aviso"*
  5. Terminar con **listo** → resumen de la semana
- Rematar: *"Recordatorio automático 48h antes de cada clase. Si el alumno
  no puede ir, cancela desde WhatsApp y el hueco se libera para otro."*

### 4. Si no hay cobertura / falla algo (plan B)
- Pestaña **Mensajes WhatsApp → Simulador del bot**: réplica exacta de la
  conversación, sin depender de internet del local

### 5. Cierre (2 min)
- *"Sin apps que instalar: los alumnos usan WhatsApp, que ya tienen."*
- *"El panel funciona desde cualquier navegador, también en el móvil."*
- Precio y siguiente paso: piloto de 2 semanas con sus datos reales

## Preguntas que te harán (y respuestas)

| Pregunta | Respuesta |
|---|---|
| "¿Y si el alumno escribe cualquier cosa?" | El bot entiende texto libre; y lo que no entiende lo reconduce con opciones |
| "¿Los datos dónde están?" | Base de datos en Europa (París), cifrada, con control de acceso por usuario |
| "¿El número de WhatsApp?" | En producción, su propio número con su nombre y logo (trámite de Meta, 1-2 semanas) |
| "¿Puede escribir el bot fuera de plazo?" | El alumno puede escribir cuando quiera; las campañas automáticas son mar-jue |
| "¿Cuánto cuesta mantenerlo?" | Infraestructura ~10-15 €/mes todo incluido |

## ⚠️ Limitaciones del sandbox (mientras no haya número propio)

- El chat muestra el logo de Twilio y un texto en inglés de la cuenta trial
- Cada móvil nuevo debe enviar una vez `join of-structure` al +1 415 523 8886
- **Para la demo: usa TU móvil ya unido** y explica que en producción
  desaparece todo esto con el número propio de la autoescuela
