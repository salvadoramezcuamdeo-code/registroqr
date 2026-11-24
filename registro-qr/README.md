# Registro QR – Entregas de Tareas y Actividades (PWA 100% Offline)

Aplicación web progresiva (**Progressive Web App**) creada con HTML, CSS y JavaScript puro (Vanilla JS), sin frameworks ni procesos de compilación. Permite registrar entregas de tareas, actividades en clase, proyectos y exámenes escaneando los códigos QR de los alumnos directamente desde tu teléfono Android o iPhone, almacenando todo localmente en **IndexedDB** sin enviar ningún dato a servidores externos.

---

## 📁 Estructura del Proyecto

```text
registro-qr/
├── index.html               # Interfaz principal Mobile-First en español
├── styles.css               # Estilos responsivos, modo oscuro y hoja de impresión tamaño carta
├── app.js                   # Lógica de IndexedDB, PIN SHA-256, escáner QR, reportes y exportación
├── manifest.json            # Metadatos PWA instalable (standalone, rutas relativas)
├── sw.js                    # Service Worker 100% offline con control de versiones (CACHE_VERSION)
├── README.md                # Guía completa de uso, instalación y publicación en GitHub Pages
├── lib/
│   ├── html5-qrcode.min.js  # Librería local para lectura de códigos QR (cámara en vivo y foto)
│   └── qrcode.min.js        # Librería local para generación de códigos QR de alumnos
└── icons/
    ├── icon-192.png         # Ícono PWA de 192x192 px
    └── icon-512.png         # Ícono PWA de 512x512 px
```

---

## 🚀 Guía Paso a Paso: Publicación e Instalación

### 1. Cómo subir la carpeta a GitHub Pages desde la web de GitHub (sin usar la terminal)

Para que tu aplicación funcione en `https://tu-usuario.github.io/nombre-repo/`, el archivo `index.html` debe quedar directamente en la **raíz** del repositorio:

1. Entra a [https://github.com](https://github.com) e inicia sesión con tu cuenta.
2. En la esquina superior derecha, toca el botón **`+`** y selecciona **"New repository"**.
3. En **Repository name**, escribe un nombre (por ejemplo: `registro-qr`).
4. Asegúrate de que el repositorio sea **Public** (requerido para GitHub Pages gratuito).
5. Marca la casilla **"Add a README file"** (o déjala sin marcar y haz clic en **"Create repository"**).
6. En la página de tu nuevo repositorio, haz clic en **"Add file"** → **"Upload files"** (o en el enlace *"uploading an existing file"* si el repositorio está vacío).
7. Abre la carpeta `registro-qr` en tu computadora, **selecciona todo su contenido interno** (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `README.md`, y las carpetas `lib` e `icons`) y **arrástralos** hacia el recuadro de GitHub en el navegador.
   > **Importante:** Arrastra los archivos y subcarpetas que están *dentro* de `registro-qr`, de modo que `index.html` quede en el primer nivel del repositorio.
8. Espera a que terminen de cargarse los archivos y haz clic en el botón verde **"Commit changes"** abajo.

---

### 2. Cómo activar GitHub Pages

1. Dentro de tu repositorio en GitHub, haz clic en la pestaña **Settings** (arriba a la derecha).
2. En el menú lateral izquierdo, haz clic en **Pages** (en la sección *Code and automation*).
3. En **Build and deployment** → **Source**, verifica que esté seleccionado **"Deploy from a branch"**.
4. En **Branch**, cambia `None` por **`main`** (o `master`), selecciona la carpeta **`/ (root)`** y haz clic en **Save**.
5. Espera entre 1 y 2 minutos y recarga la página de *Settings → Pages*. Verás un recuadro arriba que dice:
   > *"Your site is live at `https://tu-usuario.github.io/registro-qr/`"*

---

### 3. Cómo instalar la app en tu teléfono (Android y iPhone)

#### En Android (Google Chrome):
1. Abre **Chrome** en tu teléfono Android y entra a la dirección de tu GitHub Pages (`https://tu-usuario.github.io/registro-qr/`).
2. Configura tu PIN inicial de 4 a 6 dígitos.
3. Toca el menú de tres puntos **`⋮`** en la esquina superior derecha de Chrome (o el aviso emergente inferior) y selecciona **"Instalar aplicación"** o **"Agregar a la pantalla principal"**.
4. Confirma tocando **Instalar**. El ícono **Registro QR** aparecerá en tu cajón de aplicaciones como una app nativa que funciona sin internet.

#### En iPhone / iPad (Safari):
1. Abre **Safari** en tu iPhone y entra a `https://tu-usuario.github.io/registro-qr/`.
2. Toca el botón **Compartir** (el cuadro con una flecha hacia arriba en la barra inferior de Safari).
3. Desliza hacia abajo en el menú y selecciona **"Agregar a inicio"** (*Add to Home Screen*).
4. Toca **"Agregar"** en la esquina superior derecha. Ya puedes abrir **Registro QR** desde tu pantalla de inicio en pantalla completa y 100% offline.

---

### 4. Cómo publicar una actualización

Cada vez que modifiques algún archivo y quieras que tu teléfono descargue la nueva versión:

1. Abre el archivo `sw.js` y cambia la constante de la línea 1 a un nuevo número de versión, por ejemplo:
   ```javascript
   const CACHE_VERSION = 'v2'; // antes era 'v1'
   ```
2. Ve a tu repositorio en GitHub → **Add file** → **Upload files**.
3. Arrastra los archivos modificados junto con el nuevo `sw.js` y presiona **Commit changes** (o edita `sw.js` directamente desde la web de GitHub con el ícono del lápiz ✏️).
4. Cuando abras la aplicación en tu teléfono con conexión a internet, el Service Worker detectará el cambio automáticamente y mostrará arriba el banner verde:
   > **"🔄 Hay una nueva versión, toca para actualizar"**
5. Al tocar el banner, se borrará el caché viejo y la app cargará la versión nueva conservando intactos todos tus datos de IndexedDB.
