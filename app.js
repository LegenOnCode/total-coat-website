import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, deleteDoc, updateDoc, doc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Configuración de Firebase del Proyecto
const firebaseConfig = {
  apiKey: "AIzaSyCX9awo-Qike7jB1sLH55C3zxTfQ3CXprM",
  authDomain: "total-coat-website.firebaseapp.com",
  projectId: "total-coat-website",
  storageBucket: "total-coat-website.firebasestorage.app",
  messagingSenderId: "695173299647",
  appId: "1:695173299647:web:7ac902b0e55bac0b9cf50a",
  measurementId: "G-N2WJDK00RM"
};

// Configuración de Cloudinary para Subida de Imágenes
const CLOUDINARY_CLOUD_NAME = "blagc6d0";
const CLOUDINARY_UPLOAD_PRESET = "total_coat_preset";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Utilidades para mostrar datos como texto y validar imagenes.
function elemento(tag, clase, texto) {
  const nodo = document.createElement(tag);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = String(texto ?? "");
  return nodo;
}
function urlImagen(valor) {
  try {
    const url = new URL(valor);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com"
      && url.pathname.startsWith(`/${CLOUDINARY_CLOUD_NAME}/image/upload/`) ? url.href : null;
  } catch { return null; }
}
function imagen(url, texto) {
  const img = elemento("img");
  const segura = urlImagen(url);
  if (segura) img.src = segura;
  img.alt = String(texto ?? "Foto del trabajo");
  img.loading = "lazy";
  return img;
}
function fotosDe(data) {
  const fotos = Array.isArray(data.imagenes) ? data.imagenes : [data.imagenUrl];
  return fotos.map(urlImagen).filter(Boolean);
}
let ocupado = false;
let controlesBloqueados = [];
function bloquear(valor) {
  ocupado = valor;
  if (valor) {
    controlesBloqueados = Array.from(document.querySelectorAll("#admin-section button, #admin-section input, #admin-section textarea, #admin-section select, #btn-logout"))
      .map(nodo => [nodo, nodo.disabled]);
    controlesBloqueados.forEach(([nodo]) => { nodo.disabled = true; });
  } else {
    controlesBloqueados.forEach(([nodo, previo]) => { nodo.disabled = previo; });
    controlesBloqueados = [];
  }
}
async function subirFoto(archivo) {
  const formData = new FormData();
  formData.append("file", archivo);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST", body: formData, signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`Error de subida HTTP ${res.status}`);
  const data = await res.json();
  const url = urlImagen(data.secure_url);
  if (!url) throw new Error("Cloudinary no devolvio una URL de imagen valida.");
  return url;
}

// Variable que guarda las fotos que se van a eliminar al editar
let fotosAEliminar = [];

// ==========================================
// Carga la Galería Pública desde Firestore
// ==========================================
async function cargarTrabajos() {
  const galeria = document.getElementById("galeria-grid");
  galeria.innerHTML = "<p style='color:#aaa;grid-column:1/-1;text-align:center'>Cargando trabajos...</p>";
  try {
    const snapshot = await getDocs(collection(db, "trabajos"));
    if (snapshot.empty) {
      galeria.innerHTML = "<p style='color:#aaa;grid-column:1/-1;text-align:center'>Aún no hay trabajos publicados.</p>";
      return;
    }
    galeria.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const imagenes = fotosDe(data);
      if (imagenes.length === 0) return;

      const card = document.createElement("div");
      card.className = "trabajo-card";
      const info = elemento("div", "trabajo-info");
      info.append(elemento("p", "", data.descripcion), elemento("span", "trabajo-tipo", data.tipo || "Detailing"));
      if (imagenes.length > 1) info.append(elemento("p", "trabajo-count", `${imagenes.length} fotos`));
      card.append(imagen(imagenes[0], data.descripcion), info);
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Ver fotos: ${String(data.descripcion ?? "Trabajo")}`);
      card.addEventListener("click", () => abrirModal(data, imagenes));
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirModal(data, imagenes); }
      });
      galeria.appendChild(card);
    });
  } catch (e) {
    galeria.innerHTML = "<p style='color:#aaa;grid-column:1/-1;text-align:center'>Error cargando trabajos.</p>";
    console.error(e);
  }
}

// ==========================================
// Modal de Fotos al hacer click en un trabajo
// ==========================================
let focoAnterior = null;
function abrirModal(data, imagenes) {
  focoAnterior = document.activeElement;
  document.getElementById("modal-titulo").textContent = data.descripcion;
  document.getElementById("modal-tipo").textContent = data.tipo || "Detailing";
  const cont = document.getElementById("modal-fotos");
  cont.replaceChildren(...imagenes.map(url => imagen(url, data.descripcion)));
  document.getElementById("modal-overlay").classList.add("activo");
  document.body.style.overflow = "hidden";
  document.getElementById("modal-cerrar").focus();
}

function cerrarModal() {
  document.getElementById("modal-overlay").classList.remove("activo");
  document.body.style.overflow = "";
  if (focoAnterior?.isConnected) focoAnterior.focus();
}
document.getElementById("modal-overlay").addEventListener("keydown", e => {
  if (e.key === "Escape") cerrarModal();
  if (e.key === "Tab") { e.preventDefault(); document.getElementById("modal-cerrar").focus(); }
});

document.getElementById("modal-cerrar").addEventListener("click", () => {
  cerrarModal();
});

document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("modal-overlay")) {
    cerrarModal();
  }
});

// ==========================================
// Autenticación del Administrador
// ==========================================
onAuthStateChanged(auth, user => {
  const adminPanel = document.getElementById("admin-panel");
  const loginPanel = document.getElementById("login-panel");
  const btnLogout = document.getElementById("btn-logout");
  if (user) {
    loginPanel.style.display = "none";
    adminPanel.style.display = "block";
    btnLogout.style.display = "inline-block";
    cargarListaAdmin();
  } else {
    loginPanel.style.display = "block";
    adminPanel.style.display = "none";
    btnLogout.style.display = "none";
    document.getElementById("edit-panel").style.display = "none";
    document.getElementById("admin-lista").replaceChildren();
    document.getElementById("edit-fotos-actuales").replaceChildren();
    ["admin-password", "edit-id", "edit-descripcion", "edit-fotos-nuevas", "upload-fotos", "upload-descripcion"].forEach(id => { document.getElementById(id).value = ""; });
    fotosAEliminar = [];
  }
});

document.getElementById("btn-login").addEventListener("click", async () => {
  if (ocupado) return;
  const email = document.getElementById("admin-email").value.trim();
  const password = document.getElementById("admin-password").value;
  const error = document.getElementById("login-error");
  if (!email || !password) { error.textContent = "Ingresá el correo y la contraseña."; return; }
  bloquear(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    error.textContent = "";
    document.getElementById("admin-password").value = "";
  } catch (e) {
    error.textContent = "No se pudo iniciar sesión. Revisá tus datos y conexión.";
  } finally { bloquear(false); }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  if (ocupado) return;
  bloquear(true);
  try { await signOut(auth); } catch { alert("No se pudo cerrar sesión. Intentá de nuevo."); }
  finally { bloquear(false); }
});

// ==========================================
// Subida de Nuevo Trabajo con Múltiples Fotos
// ==========================================

// Función de Validación de Fotos - Verifica tamaño máximo 10MB y formatos permitidos
function validarFotos(archivos) {
  const MAX_MB = 10;
  const MAX_BYTES = MAX_MB * 1024 * 1024;
  const FORMATOS = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

  if (archivos.length > 10) return "Podés seleccionar como máximo 10 fotos.";
  for (const archivo of archivos) {
    if (archivo.size === 0) return `El archivo "${archivo.name}" está vacío.`;
    if (!FORMATOS.includes(archivo.type)) {
      return `El archivo "${archivo.name}" no es un formato válido. Solo se permiten JPG, PNG y WebP.`;
    }
    if (archivo.size > MAX_BYTES) {
      return `El archivo "${archivo.name}" supera el límite de ${MAX_MB}MB. Comprimilo antes de subirlo.`;
    }
  }
  return null;
}

document.getElementById("btn-subir").addEventListener("click", async () => {
  if (ocupado || !auth.currentUser) return;
  const archivos = Array.from(document.getElementById("upload-fotos").files);
  const descripcion = document.getElementById("upload-descripcion").value.trim();
  const tipo = document.getElementById("upload-tipo").value;
  const status = document.getElementById("upload-status");
  const btnSubir = document.getElementById("btn-subir");

  if (archivos.length === 0 || !descripcion || descripcion.length > 2000) {
    status.textContent = "Seleccioná al menos una foto y escribí una descripción de hasta 2000 caracteres.";
    status.style.color = "#ff4444";
    return;
  }

  // Validación de Fotos antes de subir
  const errorValidacion = validarFotos(archivos);
  if (errorValidacion) {
    status.textContent = errorValidacion;
    status.style.color = "#ff4444";
    return;
  }

  // Deshabilita el botón para evitar doble clic mientras procesa
  bloquear(true);
  btnSubir.textContent = "Subiendo...";
  status.textContent = `Subiendo ${archivos.length} foto(s)...`;
  status.style.color = "#aaa";

  try {
    const urls = [];
    for (let i = 0; i < archivos.length; i++) {
      status.textContent = `Subiendo foto ${i + 1} de ${archivos.length}...`;
      urls.push(await subirFoto(archivos[i]));
    }

    await addDoc(collection(db, "trabajos"), {
      imagenes: urls,
      descripcion,
      tipo,
      fecha: serverTimestamp()
    });

    status.textContent = "¡Trabajo publicado correctamente!";
    status.style.color = "#4caf50";
    document.getElementById("upload-fotos").value = "";
    document.getElementById("upload-descripcion").value = "";
    await cargarTrabajos();
    await cargarListaAdmin();
  } catch (e) {
    status.textContent = "Error al subir. Intentá de nuevo.";
    status.style.color = "#ff4444";
    console.error(e);
  } finally {
    // Reactiva el botón siempre, haya error o no
    bloquear(false);
    btnSubir.textContent = "Publicar trabajo";
  }
});

// ==========================================
// Lista de Publicaciones en el Panel Admin
// ==========================================
async function cargarListaAdmin() {
  const lista = document.getElementById("admin-lista");
  lista.innerHTML = "<p style='color:var(--gris-texto)'>Cargando...</p>";
  try {
    const snapshot = await getDocs(collection(db, "trabajos"));
    if (snapshot.empty) {
      lista.innerHTML = "<p style='color:var(--gris-texto)'>No hay publicaciones aún.</p>";
      return;
    }
    lista.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const imagenes = fotosDe(data);
      const item = document.createElement("div");
      item.className = "admin-item";
      const info = elemento("div", "admin-item-info");
      info.append(elemento("p", "", data.descripcion), elemento("span", "", `${data.tipo || "Detailing"} · ${imagenes.length} foto(s)`));
      const acciones = elemento("div", "admin-item-acciones");
      const editar = elemento("button", "btn-editar", "Editar");
      const eliminar = elemento("button", "btn-danger", "Eliminar");
      editar.dataset.id = eliminar.dataset.id = docSnap.id;
      acciones.append(editar, eliminar);
      item.append(imagen(imagenes[0], data.descripcion), info, acciones);

      // Guarda las imágenes en el elemento para usarlas al editar
      item.querySelector(".btn-editar")._imagenes = imagenes;
      item.querySelector(".btn-editar")._data = data;

      lista.appendChild(item);
    });

    // Botones Editar - Abre el formulario de edición con los datos del trabajo
    lista.querySelectorAll(".btn-editar").forEach(btn => {
      btn.addEventListener("click", () => {
        if (ocupado) return;
        const imagenes = btn._imagenes;
        const data = btn._data;
        fotosAEliminar = [];

        document.getElementById("edit-id").value = btn.dataset.id;
        document.getElementById("edit-descripcion").value = data.descripcion;
        document.getElementById("edit-tipo").value = data.tipo || "Detailing";
        document.getElementById("edit-fotos-nuevas").value = "";
        document.getElementById("edit-status").textContent = "";

        // Muestra las fotos actuales con botón X para eliminar individualmente
        const contenedor = document.getElementById("edit-fotos-actuales");
        contenedor.innerHTML = "";
        imagenes.forEach(url => {
          const item = document.createElement("div");
          item.className = "edit-foto-item";
          item.dataset.url = url;
          const quitar = elemento("button", "edit-foto-x", "✕");
          quitar.type = "button";
          quitar.title = "Eliminar esta foto";
          quitar.setAttribute("aria-label", "Eliminar esta foto");
          item.append(imagen(url, "Foto del trabajo"), quitar);
          item.querySelector(".edit-foto-x").addEventListener("click", () => {
            fotosAEliminar.push(url);
            item.style.opacity = "0.3";
            item.querySelector(".edit-foto-x").disabled = true;
          });
          contenedor.appendChild(item);
        });

        document.getElementById("edit-panel").style.display = "block";
      });
    });

    // Botones Eliminar - Borra la publicación completa de Firestore
    lista.querySelectorAll(".btn-danger").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (ocupado || !auth.currentUser) return;
        if (!confirm("¿Seguro que querés eliminar esta publicación?")) return;
        bloquear(true);
        try {
          await deleteDoc(doc(db, "trabajos", btn.dataset.id));
          if (document.getElementById("edit-id").value === btn.dataset.id) {
            document.getElementById("edit-panel").style.display = "none";
            fotosAEliminar = [];
          }
          await cargarListaAdmin();
          await cargarTrabajos();
        } catch (e) {
          alert("Error al eliminar.");
          console.error(e);
        } finally { bloquear(false); }
      });
    });

  } catch (e) {
    lista.innerHTML = "<p style='color:#ff4444'>Error cargando publicaciones.</p>";
    console.error(e);
  }
}

// ==========================================
// Guardar Cambios al Editar una Publicación
// ==========================================
document.getElementById("btn-guardar-edit").addEventListener("click", async () => {
  if (ocupado || !auth.currentUser) return;
  const id = document.getElementById("edit-id").value;
  const descripcion = document.getElementById("edit-descripcion").value.trim();
  const tipo = document.getElementById("edit-tipo").value;
  const status = document.getElementById("edit-status");
  const archivosNuevos = Array.from(document.getElementById("edit-fotos-nuevas").files);
  const btnGuardar = document.getElementById("btn-guardar-edit");

  if (!descripcion || descripcion.length > 2000) {
    status.textContent = "La descripción debe tener entre 1 y 2000 caracteres.";
    status.style.color = "#ff4444";
    return;
  }

  const fotosActuales = Array.from(document.getElementById("edit-fotos-actuales").querySelectorAll(".edit-foto-item"))
    .filter(item => !fotosAEliminar.includes(item.dataset.url)).map(item => item.dataset.url);
  const total = fotosActuales.length + archivosNuevos.length;
  if (total < 1 || total > 10) {
    status.textContent = "La publicación debe tener entre 1 y 10 fotos en total.";
    status.style.color = "#ff4444";
    return;
  }

  // Validación de Fotos Nuevas antes de subir
  if (archivosNuevos.length > 0) {
    const errorValidacion = validarFotos(archivosNuevos);
    if (errorValidacion) {
      status.textContent = errorValidacion;
      status.style.color = "#ff4444";
      return;
    }
  }

  // Deshabilita el botón para evitar doble clic mientras procesa
  bloquear(true);
  btnGuardar.textContent = "Guardando...";
  status.textContent = "Guardando cambios...";
  status.style.color = "#aaa";

  try {
    // Sube las fotos nuevas si las hay
    const urlsNuevas = [];
    for (let i = 0; i < archivosNuevos.length; i++) {
      status.textContent = `Subiendo foto nueva ${i + 1} de ${archivosNuevos.length}...`;
      urlsNuevas.push(await subirFoto(archivosNuevos[i]));
    }

    // Combina fotos que quedan + fotos nuevas
    const imagenesFinales = [...fotosActuales, ...urlsNuevas];

    if (imagenesFinales.length === 0) {
      status.textContent = "Debe quedar al menos una foto en la publicación.";
      status.style.color = "#ff4444";
      return;
    }

    await updateDoc(doc(db, "trabajos", id), { descripcion, tipo, imagenes: imagenesFinales });

    status.textContent = "¡Guardado correctamente!";
    status.style.color = "#4caf50";
    fotosAEliminar = [];
    document.getElementById("edit-panel").style.display = "none";
    await cargarListaAdmin();
    await cargarTrabajos();
  } catch (e) {
    status.textContent = "Error al guardar.";
    status.style.color = "#ff4444";
    console.error(e);
  } finally {
    // Reactiva el botón siempre, haya error o no
    bloquear(false);
    btnGuardar.textContent = "Guardar cambios";
  }
});

document.getElementById("btn-cancelar-edit").addEventListener("click", () => {
  if (ocupado) return;
  document.getElementById("edit-panel").style.display = "none";
  fotosAEliminar = [];
});

// ==========================================
// Tabs del Panel de Administración
// ==========================================
document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    if (ocupado) return;
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("activo"));
    document.querySelectorAll(".admin-tab-content").forEach(c => c.classList.remove("activo"));
    tab.classList.add("activo");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("activo");
    if (tab.dataset.tab === "lista") cargarListaAdmin();
  });
});

// Toggle para mostrar u ocultar el Panel Admin
document.getElementById("btn-admin-toggle").addEventListener("click", () => {
  const section = document.getElementById("admin-section");
  const abierto = getComputedStyle(section).display === "none";
  section.style.display = abierto ? "block" : "none";
  document.getElementById("btn-admin-toggle").setAttribute("aria-expanded", String(abierto));
  if (abierto) section.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Carga inicial de la galería pública
cargarTrabajos();
