# Conectar el dominio exitautoescuelacrm.es

Dominio: **exitautoescuelacrm.es** — el CRM en la raíz.
El fichero `CNAME` del repo ya está creado ✅. Faltan 2 pasos manuales.

## Paso 1 — DNS (en el panel de tu proveedor del dominio)

Entra donde compraste el dominio → zona DNS → añade estos registros:

### Registros A (obligatorios, apuntan a GitHub Pages)
| Tipo | Nombre / Host | Valor |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

### (Opcional) IPv6 — AAAA
| Tipo | Nombre | Valor |
|---|---|---|
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

### (Opcional) que `www.exitautoescuelacrm.es` también funcione
| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `www` | `bervanai.github.io` |

> Nota: `@` significa el dominio raíz. Algunos paneles piden dejar el
> "Host" vacío o poner el dominio completo en vez de `@`. El TTL por
> defecto vale.

## Paso 2 — Activar en GitHub

1. Ir a: repo `bervanai/autoescuela-crm` → **Settings → Pages**
2. En **Custom domain** escribir: `exitautoescuelacrm.es` → **Save**
   (el fichero CNAME ya está, así que puede aparecer relleno)
3. Esperar a que verifique el DNS (de minutos a unas horas la primera vez)
4. Marcar **Enforce HTTPS** cuando se active (certificado automático gratis)

## Comprobar

```bash
# Cuando el DNS haya propagado:
curl -I https://exitautoescuelacrm.es
```
Debe responder `200` y servir el CRM.

---

## El bot y la base de datos NO cambian
- Bot: sigue en Railway (`autoescuela-bot-production.up.railway.app`)
- Base de datos: sigue en Supabase
- El alumno nunca ve esas URLs (habla por WhatsApp)

Si en el futuro quieres el bot en `api.exitautoescuelacrm.es`:
Railway → Settings → Networking → Custom Domain, añadir el CNAME que
indique, y actualizar el webhook en Twilio + la URL del bot en el CRM.
