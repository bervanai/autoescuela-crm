# Guía para conectar un dominio propio

Sustituye `TU-DOMINIO.com` por el dominio real en todos los pasos.

## Parte 1 — El CRM en tu dominio (GitHub Pages)

El CRM se sirve desde GitHub Pages. Conectar el dominio es gratis.

### 1. Crear el fichero CNAME en el repo
En la raíz del repo debe existir un fichero llamado `CNAME` (sin extensión)
con una sola línea: el dominio. Ej:
```
crm.tu-dominio.com
```
> Claude lo crea por ti en cuanto le digas el dominio exacto.

### 2. Configurar el DNS (en el panel de donde compres el dominio)

**Opción A — subdominio (recomendado, ej: `crm.tu-dominio.com`):**
| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `crm` | `bervanai.github.io` |

**Opción B — dominio raíz (ej: `tu-dominio.com`):**
| Tipo | Nombre | Valor |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

### 3. Activar en GitHub
Repo → Settings → Pages → "Custom domain" → escribir el dominio → Save
→ marcar "Enforce HTTPS" (tarda unos minutos en activarse el certificado).

---

## Parte 2 — El bot en tu dominio (opcional, Railway)

Por defecto el bot vive en `autoescuela-bot-production.up.railway.app`.
Si quieres `api.tu-dominio.com`:

1. Railway → proyecto → Settings → Networking → "Custom Domain" →
   escribir `api.tu-dominio.com`
2. Añadir en tu DNS el CNAME que Railway te indique
3. Cambiar la URL del bot en el CRM (Configuración → URL del bot) y
   actualizar el webhook en Twilio a `https://api.tu-dominio.com/bot`

> No es imprescindible: el bot funciona igual con la URL de Railway. El
> alumno nunca ve esa URL (habla por WhatsApp).

---

## Resumen de lo que hará Claude cuando le des el dominio
- Crear el fichero `CNAME` en el repo y subirlo
- Dejarte los registros DNS exactos a copiar/pegar
- (Si quieres el bot en subdominio) preparar el cambio de URL y webhook
