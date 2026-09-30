'use strict';
// OrbitaOs - panel de operaciones.

/* =========================================================================
 * Utilidades
 * ====================================================================== */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/** Escapa texto para poder insertarlo en HTML sin riesgo. */
function esc(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Llama a la API y devuelve el JSON.
async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    method: opciones.metodo || (opciones.cuerpo ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opciones.cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
  });

  let datos = null;
  try {
    datos = await res.json();
  } catch (_) {
    datos = null;
  }

  if (res.status === 401) {
    mostrarLogin();
    throw new Error('La sesión venció. Volvé a entrar.');
  }
  if (!res.ok) {
    const error = new Error((datos && datos.error) || `Error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return datos;
}

/** Aviso flotante que se va solo. */
function avisar(mensaje, malo = false) {
  const nodo = document.createElement('div');
  nodo.className = malo ? 'aviso mal' : 'aviso';
  nodo.textContent = mensaje;
  $('#avisos').appendChild(nodo);
  setTimeout(() => nodo.remove(), 4500);
}

/** Fecha y hora cortas, en la zona del navegador. */
function fechaCorta(valor) {
  if (!valor) return '—';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Solo la hora. */
function horaCorta(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
}

/** Fecha de un input datetime-local, en hora local del navegador. */
function paraInputFecha(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const dos = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${d.getDate()}` +
    `T${dos(d.getHours())}:${dos(d.getMinutes())}`
  );
}

/** Solo el dia, para inputs type=date. */
function paraInputDia(valor) {
  const completo = paraInputFecha(valor);
  return completo ? completo.slice(0, 10) : '';
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTOS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const ETIQUETA_COLUMNA = {
  backlog: 'Pendientes',
  todo: 'Por hacer',
  in_progress: 'En curso',
  review: 'Revisión',
  done: 'Terminadas',
};
const ETIQUETA_PRIORIDAD = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  urgent: 'Urgente',
};
const ETIQUETA_ESTADO = {
  confirmed: 'Confirmado',
  cancelled: 'Cancelado',
  done: 'Hecho',
};
const ETIQUETA_MODO = {
  once: 'Una sola vez',
  yearly: 'Todos los años',
  monthly: 'Todos los meses',
  weekly: 'Todas las semanas',
  daily: 'Todos los días',
};

/** Estado en memoria del panel. */
const cache = {
  usuario: null,
  contactos: [],
  eventos: [],
  tareas: [],
  programados: [],
  conversaciones: [],
  conversacionActiva: null,
  mesCalendario: new Date(),
  filtros: { tareas: '', responsable: '', mensajes: '', direccion: '', contacto: '' },
};

/* =========================================================================
 * Acceso
 * ====================================================================== */

function mostrarLogin(mensaje) {
  cache.usuario = null;
  $('#app').classList.add('oculto');
  $('#login').classList.remove('oculto');
  $('#login-error').textContent = mensaje || '';
  $('#login-clave').value = '';
}

function mostrarApp(usuario) {
  cache.usuario = usuario;
  $('#login').classList.add('oculto');
  $('#app').classList.remove('oculto');
  $('#quien-soy').textContent =
    `${usuario.firstName || usuario.name} · ${usuario.role}`;
  irAVista('panel');
}

/** Comprueba si hay sesion abierta al cargar la pagina. */
async function comprobarSesion() {
  try {
    const datos = await api('/api/sesion');
    mostrarApp(datos.usuario);
  } catch (_) {
    mostrarLogin();
  }
}

/* =========================================================================
 * Navegacion
 * ====================================================================== */

/** Vistas que hay que refrescar al entrar. */
const CARGADORES = {
  panel: cargarPanel,
  calendario: cargarCalendario,
  tablero: cargarTablero,
  mensajes: cargarMensajes,
  contactos: cargarContactos,
  programados: cargarProgramados,
  consumo: cargarConsumo,
};

/** Cambia de vista y dispara su carga de datos. */
function irAVista(nombre) {
  $$('.pestana').forEach((p) => p.classList.toggle('activa', p.dataset.vista === nombre));
  $$('.vista').forEach((v) => v.classList.toggle('activa', v.id === `vista-${nombre}`));

  const cargar = CARGADORES[nombre];
  if (cargar) {
    cargar().catch((err) => avisar(err.message, true));
  }
}

// En vez de un formulario por entidad, se describe la lista de campos y el modal los dibuja.

let alEnviarModal = null;

function cerrarModal() {
  $('#modal').classList.add('oculto');
  $('#modal-forma').innerHTML = '';
  $('#modal-error').textContent = '';
  alEnviarModal = null;
}

// Dibuja un campo del formulario.
function campoHtml(campo) {
  const id = `campo-${campo.nombre}`;
  const requerido = campo.requerido ? ' required' : '';
  const valor = campo.valor === null || campo.valor === undefined ? '' : campo.valor;

  if (campo.tipo === 'checkbox') {
    return `
      <div class="campo" data-grupo="${esc(campo.grupo || '')}">
        <div class="casilla">
          <input type="checkbox" id="${id}" data-campo="${esc(campo.nombre)}"
                 data-tipo="checkbox" ${valor ? 'checked' : ''}>
          <label for="${id}" style="margin:0">${esc(campo.etiqueta)}</label>
        </div>
        ${campo.ayuda ? `<span class="campo-ayuda">${esc(campo.ayuda)}</span>` : ''}
      </div>`;
  }

  let control;

  if (campo.tipo === 'select') {
    const opciones = (campo.opciones || [])
      .map((o) => {
        const v = typeof o === 'object' ? o.valor : o;
        const t = typeof o === 'object' ? o.texto : o;
        return `<option value="${esc(v)}" ${String(v) === String(valor) ? 'selected' : ''}>${esc(t)}</option>`;
      })
      .join('');
    control = `<select id="${id}" data-campo="${esc(campo.nombre)}" data-tipo="select"${requerido}>${opciones}</select>`;
  } else if (campo.tipo === 'textarea') {
    control = `<textarea id="${id}" data-campo="${esc(campo.nombre)}" data-tipo="texto"${requerido}>${esc(valor)}</textarea>`;
  } else {
    const extras = [
      campo.min !== undefined ? `min="${campo.min}"` : '',
      campo.max !== undefined ? `max="${campo.max}"` : '',
      campo.paso ? `step="${campo.paso}"` : '',
      campo.placeholder ? `placeholder="${esc(campo.placeholder)}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    control = `<input id="${id}" type="${campo.tipo || 'text'}" data-campo="${esc(campo.nombre)}"
                      data-tipo="texto" value="${esc(valor)}" ${extras}${requerido}>`;
  }

  return `
    <div class="campo" data-grupo="${esc(campo.grupo || '')}">
      <label for="${id}">${esc(campo.etiqueta)}</label>
      ${control}
      ${campo.ayuda ? `<span class="campo-ayuda">${esc(campo.ayuda)}</span>` : ''}
    </div>`;
}

// Abre el modal.
function abrirModal({ titulo, campos, textoBoton = 'Guardar', alEnviar }) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-error').textContent = '';
  $('#modal-forma').innerHTML =
    campos.map(campoHtml).join('') +
    `<div class="modal-pie">
       <button type="button" class="boton-suave" id="modal-cancelar">Cancelar</button>
       <button type="submit" class="boton">${esc(textoBoton)}</button>
     </div>`;

  alEnviarModal = alEnviar;
  $('#modal').classList.remove('oculto');

  const primero = $('#modal-forma input:not([type=hidden]), #modal-forma textarea, #modal-forma select');
  if (primero) primero.focus();
}

/** Junta los valores del formulario del modal. */
function leerModal() {
  const datos = {};
  $$('#modal-forma [data-campo]').forEach((nodo) => {
    const nombre = nodo.dataset.campo;
    if (nodo.dataset.tipo === 'checkbox') datos[nombre] = nodo.checked;
    else datos[nombre] = nodo.value;
  });
  return datos;
}

/* =========================================================================
 * Vista: Panel
 * ====================================================================== */

/** Tarjeta de estado. */
function tarjeta(etiqueta, valor, clase, detalle) {
  return `
    <div class="tarjeta">
      <div class="etiqueta">${esc(etiqueta)}</div>
      <div class="valor ${clase || ''}">${esc(valor)}</div>
      ${detalle ? `<div class="detalle">${esc(detalle)}</div>` : ''}
    </div>`;
}

async function cargarPanel() {
  const datos = await api('/api/resumen');
  const e = datos.estado;

  const vinculado = e.whatsapp === 'vinculado';
  const uso = e.uso_ia || {};

  $('#saludo').textContent = `Hola, ${
    cache.usuario ? cache.usuario.firstName || cache.usuario.name : ''
  }`;

  $('#tarjetas-estado').innerHTML = [
    tarjeta(
      'WhatsApp',
      vinculado ? 'Vinculado' : 'Sin vincular',
      vinculado ? 'ok' : 'mal',
      vinculado ? 'Recibiendo mensajes' : 'Revisá el código de abajo'
    ),
    tarjeta(
      'Base de datos',
      e.base === 'conectada' ? 'Conectada' : 'Caída',
      e.base === 'conectada' ? 'ok' : 'mal',
      `${e.conteos.messages} mensajes guardados`
    ),
    tarjeta('Mensajes hoy', String(datos.mensajes_hoy), '', 'Entrantes y salientes'),
    tarjeta(
      'Consumo IA',
      String(uso.llamadas || uso.requests || uso.total || 0),
      '',
      `${uso.tokens || uso.tokens_total || 0} tokens · ${e.ia}`
    ),
  ].join('');

  // Aviso de vinculacion: solo aparece cuando hace falta.
  const aviso = $('#aviso-vinculacion');
  if (e.codigo_vinculacion) {
    aviso.innerHTML = `
      <h3>⚠ WhatsApp todavía no está vinculado</h3>
      <div class="codigo">${esc(e.codigo_vinculacion)}</div>
      <ol>
        <li>Abrí WhatsApp en el teléfono de OrbitaOs.</li>
        <li>Menú ≡ → <strong>Dispositivos vinculados</strong>.</li>
        <li><strong>Vincular con número de teléfono</strong>.</li>
        <li>Ingresá el código de arriba dentro de los 3 minutos.</li>
      </ol>
      <p class="ayuda">El código se renueva cada pocos minutos: si falla, recargá esta página.</p>`;
    aviso.classList.remove('oculto');
  } else {
    aviso.classList.add('oculto');
    aviso.innerHTML = '';
  }

  // Proximos eventos.
  $('#panel-eventos').innerHTML = datos.proximos_eventos.length
    ? datos.proximos_eventos
        .map(
          (ev) => `
      <div class="fila">
        <div>
          <div class="titulo">${esc(ev.title)}</div>
          <div class="sub">${esc(fechaCorta(ev.startAt))}${
            ev.location ? ` · ${esc(ev.location)}` : ''
          }</div>
        </div>
        <span class="chip">${esc(ev.owner)}</span>
      </div>`
        )
        .join('')
    : '<p class="vacio">No hay eventos confirmados en los próximos 7 días.</p>';

  // Lo que requiere atencion: primero lo vencido.
  const atencion = [
    ...datos.tareas_vencidas.map((t) => ({ ...t, vencida: true })),
    ...datos.tareas_urgentes,
  ];
  $('#panel-tareas').innerHTML = atencion.length
    ? atencion
        .map(
          (t) => `
      <div class="fila">
        <div>
          <div class="titulo">${esc(t.title)}</div>
          <div class="sub">${esc(ETIQUETA_COLUMNA[t.status] || t.status)}${
            t.dueAt ? ` · vence ${esc(fechaCorta(t.dueAt))}` : ''
          }</div>
        </div>
        <span class="chip ${esc(t.priority)}">${
          t.vencida ? 'Vencida' : esc(ETIQUETA_PRIORIDAD[t.priority] || t.priority)
        }</span>
      </div>`
        )
        .join('')
    : '<p class="vacio">Nada urgente. Buen momento para adelantar trabajo.</p>';

  // Tablero de un vistazo.
  $('#panel-tablero').innerHTML = datos.tablero
    .map(
      (c) => `
    <div class="celda">
      <div class="n">${c.total}</div>
      <div class="t">${esc(ETIQUETA_COLUMNA[c.columna] || c.columna)}</div>
    </div>`
    )
    .join('');
}

/* =========================================================================
 * Vista: Calendario
 * ====================================================================== */

/** Clave local de un dia, en formato AAAA-MM-DD. */
function claveDia(fecha) {
  const d = new Date(fecha);
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

async function cargarCalendario() {
  const base = cache.mesCalendario;
  const desde = new Date(base.getFullYear(), base.getMonth(), 1);
  const hasta = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 59, 999);

  const datos = await api(
    `/api/eventos?desde=${encodeURIComponent(desde.toISOString())}` +
      `&hasta=${encodeURIComponent(hasta.toISOString())}&limite=500`
  );

  cache.eventos = datos.eventos;
  pintarCalendario();
  pintarListaEventos();
}

function pintarCalendario() {
  const base = cache.mesCalendario;
  const anio = base.getFullYear();
  const mes = base.getMonth();

  $('#mes-actual').textContent = `${MESES[mes]} ${anio}`;

  // La semana empieza el lunes, como en Paraguay.
  const primero = new Date(anio, mes, 1);
  const desplazamiento = (primero.getDay() + 6) % 7;
  const inicio = new Date(anio, mes, 1 - desplazamiento);

  // Los eventos se agrupan por dia para no recorrer la lista en cada celda.
  const porDia = new Map();
  for (const ev of cache.eventos) {
    const clave = claveDia(ev.startAt);
    if (!porDia.has(clave)) porDia.set(clave, []);
    porDia.get(clave).push(ev);
  }

  const claveHoy = claveDia(new Date());
  const celdas = DIAS_CORTOS.map((d) => `<div class="dia-semana">${d}</div>`);

  for (let i = 0; i < 42; i += 1) {
    const dia = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
    const clave = claveDia(dia);
    const eventos = porDia.get(clave) || [];

    const clases = ['dia'];
    if (dia.getMonth() !== mes) clases.push('fuera');
    if (clave === claveHoy) clases.push('hoy');

    const visibles = eventos.slice(0, 3);
    const resto = eventos.length - visibles.length;

    celdas.push(`
      <div class="${clases.join(' ')}" data-dia="${clave}">
        <span class="numero">${dia.getDate()}</span>
        ${visibles
          .map(
            (ev) => `
          <div class="evento ${esc(ev.status)}" data-evento="${esc(String(ev._id))}"
               title="${esc(ev.title)} · ${esc(horaCorta(ev.startAt))}">
            ${esc(horaCorta(ev.startAt))} ${esc(ev.title)}
          </div>`
          )
          .join('')}
        ${resto > 0 ? `<span class="numero">+${resto} más</span>` : ''}
      </div>`);
  }

  $('#calendario').innerHTML = celdas.join('');
}

function pintarListaEventos() {
  $('#lista-eventos').innerHTML = cache.eventos.length
    ? cache.eventos
        .map(
          (ev) => `
      <div class="fila">
        <div>
          <div class="titulo">${esc(ev.title)}</div>
          <div class="sub">${esc(fechaCorta(ev.startAt))}${
            ev.location ? ` · ${esc(ev.location)}` : ''
          } · ${esc(ev.owner)}</div>
        </div>
        <div class="der">
          <span class="chip ${esc(ev.status)}">${esc(ETIQUETA_ESTADO[ev.status] || ev.status)}</span>
          <button class="boton-suave" data-editar-evento="${esc(String(ev._id))}">Editar</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="vacio">No hay eventos este mes. Hacé clic en un día para crear uno.</p>';
}

/** Campos del formulario de un evento. */
function camposEvento(ev) {
  return [
    { nombre: 'title', etiqueta: 'Título', valor: ev ? ev.title : '', requerido: true },
    {
      nombre: 'startAt',
      etiqueta: 'Empieza',
      tipo: 'datetime-local',
      valor: paraInputFecha(ev ? ev.startAt : new Date()),
      requerido: true,
    },
    {
      nombre: 'endAt',
      etiqueta: 'Termina (opcional)',
      tipo: 'datetime-local',
      valor: paraInputFecha(ev ? ev.endAt : null),
      ayuda: 'Se usa para cerrar el evento solo cuando ya pasó.',
    },
    { nombre: 'location', etiqueta: 'Lugar (opcional)', valor: ev ? ev.location : '' },
    {
      nombre: 'description',
      etiqueta: 'Notas',
      tipo: 'textarea',
      valor: ev ? ev.description : '',
    },
    {
      nombre: 'owner',
      etiqueta: 'Teléfono que recibe el recordatorio',
      valor: ev ? ev.owner : cache.usuario.phone || '',
      requerido: true,
      ayuda: 'Formato internacional sin +. Ej: 595981123456',
    },
    {
      nombre: 'status',
      etiqueta: 'Estado',
      tipo: 'select',
      valor: ev ? ev.status : 'confirmed',
      opciones: Object.entries(ETIQUETA_ESTADO).map(([valor, texto]) => ({ valor, texto })),
    },
  ];
}

/** Abre el formulario de evento. Sin `evento` crea; con `evento` edita. */
function formularioEvento(evento, diaBase) {
  const ev = evento || (diaBase ? { startAt: `${diaBase}T09:00` } : null);
  const esNuevo = !evento;

  abrirModal({
    titulo: esNuevo ? 'Nuevo evento' : 'Editar evento',
    campos: camposEvento(ev),
    textoBoton: esNuevo ? 'Crear' : 'Guardar',
    alEnviar: async (datos) => {
      const cuerpo = {
        title: datos.title,
        startAt: new Date(datos.startAt).toISOString(),
        endAt: datos.endAt ? new Date(datos.endAt).toISOString() : null,
        location: datos.location,
        description: datos.description,
        owner: datos.owner,
        status: datos.status,
      };

      if (esNuevo) await api('/api/eventos', { cuerpo });
      else await api(`/api/eventos/${evento._id}`, { metodo: 'PATCH', cuerpo });

      cerrarModal();
      avisar(esNuevo ? 'Evento creado.' : 'Evento actualizado.');
      await cargarCalendario();
    },
  });
}

/** Borra un evento, pidiendo confirmacion. */
async function borrarEvento(id) {
  const ev = cache.eventos.find((e) => String(e._id) === String(id));
  if (!ev) return;
  if (!confirm(`¿Borrar el evento "${ev.title}"?`)) return;
  await api(`/api/eventos/${id}`, { metodo: 'DELETE' });
  avisar('Evento borrado.');
  await cargarCalendario();
}

/* =========================================================================
 * Vista: Tablero (Kanban)
 * ====================================================================== */

async function cargarTablero() {
  // El selector de responsable se llena con los contactos habilitados.
  if (!cache.contactos.length) {
    try {
      const c = await api('/api/contactos');
      cache.contactos = c.contactos;
    } catch (_) {
      // Un miembro sin permisos de contactos igual puede usar su tablero.
      cache.contactos = [];
    }
  }

  const parametros = new URLSearchParams();
  if (cache.filtros.responsable) parametros.set('owner', cache.filtros.responsable);
  if (cache.filtros.tareas) parametros.set('q', cache.filtros.tareas);
  parametros.set('limite', '500');

  const datos = await api(`/api/tareas?${parametros.toString()}`);
  cache.tareas = datos.tablero.flatMap((c) => c.tareas);

  pintarSelectorResponsables();
  pintarKanban(datos.tablero, datos.columnas);
}

function pintarSelectorResponsables() {
  const selector = $('#filtro-responsable');
  const actual = cache.filtros.responsable;

  selector.innerHTML =
    '<option value="">Todos los responsables</option>' +
    cache.contactos
      .filter((c) => c.phone)
      .map(
        (c) =>
          `<option value="${esc(c.phone)}" ${c.phone === actual ? 'selected' : ''}>${esc(
            c.firstName || c.name || c.phone
          )}</option>`
      )
      .join('');
}

function pintarKanban(tablero, columnas) {
  const hoy = new Date();

  $('#kanban').innerHTML = tablero
    .map(
      (col) => `
    <div class="columna" data-columna="${esc(col.columna)}">
      <h4>
        <span>${esc(ETIQUETA_COLUMNA[col.columna] || col.columna)}</span>
        <span class="chip">${col.tareas.length}</span>
      </h4>
      <div class="cuerpo">
        ${col.tareas
          .map((t) => {
            const vencida = t.dueAt && new Date(t.dueAt) < hoy && t.status !== 'done';
            return `
          <div class="tarjeta-tarea ${vencida ? 'vencida' : ''}" draggable="true"
               data-tarea="${esc(String(t._id))}">
            <div class="t">${esc(t.title)}</div>
            ${t.description ? `<div class="d">${esc(t.description.slice(0, 90))}</div>` : ''}
            <div class="pie">
              <span class="chip ${esc(t.priority)}">${esc(
                ETIQUETA_PRIORIDAD[t.priority] || t.priority
              )}</span>
              ${t.dueAt ? `<span class="chip ${vencida ? 'off' : ''}">${esc(
                paraInputDia(t.dueAt).split('-').reverse().join('/')
              )}</span>` : ''}
              ${(t.labels || []).map((l) => `<span class="chip">${esc(l)}</span>`).join('')}
              <button class="boton-suave" data-editar-tarea="${esc(String(t._id))}"
                      style="padding:2px 8px;font-size:11px">Editar</button>
            </div>
          </div>`;
          })
          .join('')}
      </div>
    </div>`
    )
    .join('');
}

/* --- Arrastrar y soltar ------------------------------------------------ */

let tareaArrastrada = null;

// Conecta el arrastre del tablero una sola vez.
function conectarKanban() {
  const kanban = $('#kanban');

  kanban.addEventListener('dragstart', (ev) => {
    const tarjeta = ev.target.closest('.tarjeta-tarea');
    if (!tarjeta) return;
    tareaArrastrada = tarjeta.dataset.tarea;
    tarjeta.classList.add('arrastrando');
    ev.dataTransfer.effectAllowed = 'move';
    // Firefox no inicia el arrastre sin cargar algun dato.
    ev.dataTransfer.setData('text/plain', tareaArrastrada);
  });

  kanban.addEventListener('dragend', (ev) => {
    const tarjeta = ev.target.closest('.tarjeta-tarea');
    if (tarjeta) tarjeta.classList.remove('arrastrando');
    $$('.columna').forEach((c) => c.classList.remove('soltando'));
    tareaArrastrada = null;
  });

  kanban.addEventListener('dragover', (ev) => {
    const columna = ev.target.closest('.columna');
    if (!columna || !tareaArrastrada) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    $$('.columna').forEach((c) => c.classList.toggle('soltando', c === columna));
  });

  kanban.addEventListener('drop', async (ev) => {
    const columna = ev.target.closest('.columna');
    if (!columna || !tareaArrastrada) return;
    ev.preventDefault();
    const id = tareaArrastrada;
    tareaArrastrada = null;
    await moverTarea(id, columna.dataset.columna);
  });
}

/** Mueve una tarea a otra columna. */
async function moverTarea(id, columna) {
  const tarea = cache.tareas.find((t) => String(t._id) === String(id));
  if (!tarea || tarea.status === columna) return;

  try {
    await api(`/api/tareas/${id}`, { metodo: 'PATCH', cuerpo: { status: columna } });
    avisar(`Movida a ${ETIQUETA_COLUMNA[columna] || columna}.`);
    await cargarTablero();
  } catch (err) {
    avisar(err.message, true);
  }
}

/** Campos del formulario de una tarea. */
function camposTarea(t) {
  const contactos = cache.contactos.filter((c) => c.phone);
  return [
    { nombre: 'title', etiqueta: 'Título', valor: t ? t.title : '', requerido: true },
    {
      nombre: 'description',
      etiqueta: 'Descripción',
      tipo: 'textarea',
      valor: t ? t.description : '',
    },
    {
      nombre: 'owner',
      etiqueta: 'Responsable',
      tipo: contactos.length ? 'select' : 'text',
      valor: t ? t.owner : cache.usuario.phone || '',
      requerido: true,
      opciones: contactos.map((c) => ({
        valor: c.phone,
        texto: c.firstName || c.name || c.phone,
      })),
      ayuda: 'Teléfono del funcionario que atiende la tarea.',
    },
    {
      nombre: 'status',
      etiqueta: 'Etapa',
      tipo: 'select',
      valor: t ? t.status : 'todo',
      opciones: Object.entries(ETIQUETA_COLUMNA).map(([valor, texto]) => ({ valor, texto })),
    },
    {
      nombre: 'priority',
      etiqueta: 'Prioridad',
      tipo: 'select',
      valor: t ? t.priority : 'medium',
      opciones: Object.entries(ETIQUETA_PRIORIDAD).map(([valor, texto]) => ({ valor, texto })),
    },
    {
      nombre: 'dueAt',
      etiqueta: 'Vence (opcional)',
      tipo: 'date',
      valor: paraInputDia(t ? t.dueAt : null),
    },
    {
      nombre: 'labels',
      etiqueta: 'Etiquetas (opcional)',
      valor: t && t.labels ? t.labels.join(', ') : '',
      ayuda: 'Separadas por coma. Sirven para agrupar trabajo.',
    },
  ];
}

/** Abre el formulario de tarea. Sin `tarea` crea; con `tarea` edita. */
function formularioTarea(tarea) {
  const esNuevo = !tarea;

  abrirModal({
    titulo: esNuevo ? 'Nueva tarea' : 'Editar tarea',
    campos: camposTarea(tarea),
    textoBoton: esNuevo ? 'Crear' : 'Guardar',
    alEnviar: async (datos) => {
      const cuerpo = {
        title: datos.title,
        description: datos.description,
        owner: datos.owner,
        status: datos.status,
        priority: datos.priority,
        dueAt: datos.dueAt ? new Date(`${datos.dueAt}T12:00:00`).toISOString() : null,
        labels: datos.labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      };

      if (esNuevo) await api('/api/tareas', { cuerpo });
      else {
        // El responsable solo lo cambia un administrador: se omite si no es.
        if (datos.owner === tarea.owner) delete cuerpo.owner;
        await api(`/api/tareas/${tarea._id}`, { metodo: 'PATCH', cuerpo });
      }

      cerrarModal();
      avisar(esNuevo ? 'Tarea creada.' : 'Tarea actualizada.');
      await cargarTablero();
    },
  });
}

/** Borra una tarea. */
async function borrarTarea(id) {
  const t = cache.tareas.find((x) => String(x._id) === String(id));
  if (!t) return;
  if (!confirm(`¿Borrar la tarea "${t.title}"?`)) return;
  await api(`/api/tareas/${id}`, { metodo: 'DELETE' });
  avisar('Tarea borrada.');
  await cargarTablero();
}

/* =========================================================================
 * Vista: Mensajes
 * ====================================================================== */

async function cargarMensajes() {
  const datos = await api('/api/conversaciones');
  cache.conversaciones = datos.conversaciones;

  // Si la conversacion abierta ya no existe, se elige la primera.
  if (
    cache.conversacionActiva &&
    !cache.conversaciones.some((c) => c.chatId === cache.conversacionActiva)
  ) {
    cache.conversacionActiva = null;
  }
  if (!cache.conversacionActiva && cache.conversaciones.length) {
    cache.conversacionActiva = cache.conversaciones[0].chatId;
  }

  pintarConversaciones();

  if (cache.conversacionActiva) {
    await pintarHilo(cache.conversacionActiva);
  } else {
    $('#hilo-titulo').textContent = 'Sin conversaciones todavía';
    $('#hilo').innerHTML = '';
  }
}

function pintarConversaciones() {
  $('#lista-conversaciones').innerHTML = cache.conversaciones.length
    ? cache.conversaciones
        .map(
          (c) => `
      <div class="charla ${c.chatId === cache.conversacionActiva ? 'activa' : ''}"
           data-charla="${esc(c.chatId)}">
        <div class="n">${esc(c.nombre)}</div>
        <div class="u">${c.ultimaDireccion === 'outbound' ? '↩ ' : ''}${esc(
          String(c.ultimo).slice(0, 60)
        )}</div>
        <div class="u">${esc(c.total)} mensajes · ${esc(fechaCorta(c.ultimoAt))}</div>
      </div>`
        )
        .join('')
    : '<p class="vacio">Todavía no hay mensajes guardados.</p>';
}

/** Pinta el hilo de una conversacion, aplicando los filtros activos. */
async function pintarHilo(chatId) {
  const conversacion = cache.conversaciones.find((c) => c.chatId === chatId);
  const parametros = new URLSearchParams({ chat: chatId, limite: '300' });
  if (cache.filtros.mensajes) parametros.set('q', cache.filtros.mensajes);
  if (cache.filtros.direccion) parametros.set('direccion', cache.filtros.direccion);

  const datos = await api(`/api/mensajes?${parametros.toString()}`);

  $('#hilo-titulo').textContent = conversacion
    ? `${conversacion.nombre} · ${conversacion.telefono}`
    : chatId;

  // La API devuelve del mas nuevo al mas viejo; en pantalla va al reves.
  const ordenados = [...datos.mensajes].reverse();

  $('#hilo').innerHTML = ordenados.length
    ? ordenados
        .map(
          (m) => `
      <div class="mensaje ${esc(m.direction)}">
        ${esc(m.body)}
        <span class="hora">${esc(horaCorta(m.createdAt))}${
          m.intent ? ` · ${esc(m.intent)}` : ''
        }${m.fallback ? ' · respuesta de respaldo' : ''}</span>
      </div>`
        )
        .join('')
    : '<p class="vacio">No hay mensajes que coincidan con el filtro.</p>';

  const cuerpo = $('#hilo');
  cuerpo.scrollTop = cuerpo.scrollHeight;
}

/* =========================================================================
 * Vista: Contactos
 * ====================================================================== */

async function cargarContactos() {
  const parametros = new URLSearchParams();
  if (cache.filtros.contacto) parametros.set('q', cache.filtros.contacto);

  const datos = await api(`/api/contactos?${parametros.toString()}`);
  cache.contactos = datos.contactos;
  pintarContactos();
}

function pintarContactos() {
  $('#tabla-contactos').innerHTML = cache.contactos.length
    ? cache.contactos
        .map(
          (c) => `
      <tr>
        <td>${esc([c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '—')}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${esc(c.role)}</td>
        <td>
          <span class="chip ${c.allowed ? 'low' : 'off'}">
            ${c.allowed ? 'Habilitado' : 'Revocado'}
          </span>
        </td>
        <td>${c.birthday ? esc(paraInputDia(c.birthday).split('-').reverse().join('/')) : '—'}</td>
        <td class="acciones-celda">
          <button class="boton-suave" data-editar-contacto="${esc(c.id)}">Editar</button>
          <button class="boton-suave" data-borrar-contacto="${esc(c.id)}">Borrar</button>
        </td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6"><p class="vacio">No hay contactos cargados.</p></td></tr>';
}

/** Campos del formulario de contacto. */
function camposContacto(c) {
  return [
    {
      nombre: 'phone',
      etiqueta: 'Teléfono',
      valor: c ? c.phone : '',
      requerido: true,
      ayuda: 'Formato internacional sin + ni espacios. Ej: 595981123456',
    },
    { nombre: 'firstName', etiqueta: 'Nombre', valor: c ? c.firstName : '' },
    { nombre: 'lastName', etiqueta: 'Apellido', valor: c ? c.lastName : '' },
    {
      nombre: 'birthday',
      etiqueta: 'Cumpleaños (opcional)',
      tipo: 'date',
      valor: paraInputDia(c ? c.birthday : null),
      ayuda: 'Se usa para los saludos anuales.',
    },
    {
      nombre: 'role',
      etiqueta: 'Rol',
      tipo: 'select',
      valor: c ? c.role : 'member',
      opciones: [
        { valor: 'member', texto: 'Funcionario (member)' },
        { valor: 'admin', texto: 'Administrador (admin)' },
        { valor: 'owner', texto: 'Dueño (owner)' },
      ],
      ayuda: 'Solo admin y owner ven y editan todo el panel.',
    },
    {
      nombre: 'allowed',
      etiqueta: 'Puede escribirle al bot',
      tipo: 'checkbox',
      valor: c ? c.allowed : true,
    },
    {
      nombre: 'password',
      etiqueta: c ? 'Nueva contraseña (opcional)' : 'Contraseña para el panel (opcional)',
      tipo: 'password',
      valor: '',
      ayuda: 'Sin contraseña, el contacto solo usa WhatsApp: no entra al panel.',
    },
  ];
}

/** Abre el formulario de contacto. */
function formularioContacto(contacto) {
  const esNuevo = !contacto;

  abrirModal({
    titulo: esNuevo ? 'Nuevo contacto' : 'Editar contacto',
    campos: camposContacto(contacto),
    textoBoton: esNuevo ? 'Agregar' : 'Guardar',
    alEnviar: async (datos) => {
      const cuerpo = {
        phone: datos.phone,
        firstName: datos.firstName,
        lastName: datos.lastName,
        birthday: datos.birthday || null,
        role: datos.role,
        allowed: datos.allowed,
      };
      if (datos.password) cuerpo.password = datos.password;

      if (esNuevo) await api('/api/contactos', { cuerpo });
      else await api(`/api/contactos/${contacto.id}`, { metodo: 'PATCH', cuerpo });

      cerrarModal();
      avisar(esNuevo ? 'Contacto agregado.' : 'Contacto actualizado.');
      cache.contactos = [];
      await cargarContactos();
    },
  });
}

/** Borra un contacto. */
async function borrarContactoDe(id) {
  const c = cache.contactos.find((x) => String(x.id) === String(id));
  if (!c) return;
  const nombre = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || c.phone;
  if (!confirm(`¿Borrar el contacto "${nombre}"?`)) return;
  await api(`/api/contactos/${id}`, { metodo: 'DELETE' });
  avisar('Contacto borrado.');
  cache.contactos = [];
  await cargarContactos();
}

/* =========================================================================
 * Vista: Mensajes programados
 * ====================================================================== */

async function cargarProgramados() {
  // El destinatario se elige de los contactos habilitados.
  if (!cache.contactos.length) {
    try {
      const c = await api('/api/contactos');
      cache.contactos = c.contactos;
    } catch (_) {
      cache.contactos = [];
    }
  }

  const datos = await api('/api/programados');
  cache.programados = datos.programados;
  pintarProgramados();
}

/** Texto legible de la recurrencia. */
function describirRecurrencia(p) {
  if (p.mode === 'once') return `Una sola vez: ${fechaCorta(p.runAt)}`;
  if (p.mode === 'daily') return `Todos los días a las ${p.time}`;
  if (p.mode === 'weekly') return `Todos los ${DIAS_SEMANA[p.weekday]} a las ${p.time}`;
  if (p.mode === 'monthly') return `El día ${p.day} de cada mes a las ${p.time}`;
  if (p.mode === 'yearly') {
    return `El ${p.day} de ${MESES[p.month - 1]} de cada año a las ${p.time}`;
  }
  return ETIQUETA_MODO[p.mode] || p.mode;
}

function pintarProgramados() {
  $('#lista-programados').innerHTML = cache.programados.length
    ? cache.programados
        .map(
          (p) => `
      <div class="fila">
        <div>
          <div class="titulo">${esc(p.title || String(p.body).slice(0, 50))}</div>
          <div class="sub">${esc(describirRecurrencia(p))} · para ${esc(p.to)}</div>
          <div class="sub">${
            p.proximo_envio
              ? `Próximo envío: ${esc(fechaCorta(p.proximo_envio))}`
              : 'Sin próximos envíos'
          }${p.sentCount ? ` · enviado ${p.sentCount} vez/veces` : ''}</div>
        </div>
        <div class="der">
          <span class="chip ${p.active ? 'low' : 'off'}">${
            p.active ? 'Activo' : 'Pausado'
          }</span>
          <button class="boton-suave" data-editar-programado="${esc(p.id)}">Editar</button>
          <button class="boton-suave" data-borrar-programado="${esc(p.id)}">Borrar</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="vacio">No hay mensajes programados. Creá uno para los cumpleaños.</p>';
}

/** Campos del formulario de un mensaje programado. */
function camposProgramado(p) {
  const contactos = cache.contactos.filter((c) => c.phone);
  const dias = [
    'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
  ].map((texto, valor) => ({ valor, texto }));

  return [
    {
      nombre: 'to',
      etiqueta: 'Destinatario',
      tipo: contactos.length ? 'select' : 'text',
      valor: p ? p.to : cache.usuario.phone || '',
      requerido: true,
      opciones: contactos.map((c) => ({
        valor: c.phone,
        texto: `${c.firstName || c.name || c.phone} (${c.phone})`,
      })),
    },
    {
      nombre: 'title',
      etiqueta: 'Para reconocerlo (opcional)',
      valor: p ? p.title : '',
      placeholder: 'Cumpleaños de Ana',
    },
    {
      nombre: 'body',
      etiqueta: 'Mensaje',
      tipo: 'textarea',
      valor: p ? p.body : '¡Feliz cumpleaños, {nombre}! 🎉',
      requerido: true,
      ayuda: 'Podés usar {nombre}, {apellido} y {nombre_completo}.',
    },
    {
      nombre: 'mode',
      etiqueta: 'Cuándo se envía',
      tipo: 'select',
      valor: p ? p.mode : 'yearly',
      opciones: Object.entries(ETIQUETA_MODO).map(([valor, texto]) => ({ valor, texto })),
    },
    {
      nombre: 'runAt',
      etiqueta: 'Fecha y hora',
      tipo: 'datetime-local',
      grupo: 'once',
      valor: paraInputFecha(p && p.mode === 'once' ? p.runAt : new Date()),
    },
    {
      nombre: 'month',
      etiqueta: 'Mes',
      tipo: 'select',
      grupo: 'month',
      valor: p && p.month ? p.month : new Date().getMonth() + 1,
      opciones: MESES.map((texto, i) => ({ valor: i + 1, texto })),
    },
    {
      nombre: 'day',
      etiqueta: 'Día del mes',
      tipo: 'number',
      grupo: 'day',
      min: 1,
      max: 31,
      valor: p && p.day ? p.day : new Date().getDate(),
    },
    {
      nombre: 'weekday',
      etiqueta: 'Día de la semana',
      tipo: 'select',
      grupo: 'weekday',
      valor: p && p.weekday !== null && p.weekday !== undefined ? p.weekday : 1,
      opciones: dias,
    },
    {
      nombre: 'time',
      etiqueta: 'Hora',
      tipo: 'time',
      grupo: 'time',
      valor: p ? p.time : '09:00',
      ayuda: 'Hora local de Paraguay.',
    },
    {
      nombre: 'active',
      etiqueta: 'Activo',
      tipo: 'checkbox',
      valor: p ? p.active : true,
    },
  ];
}

/** Muestra u oculta los campos que no corresponden al modo elegido. */
function ajustarGruposProgramado() {
  const modo = $('#campo-mode');
  if (!modo) return;
  const valor = modo.value;

  const visibles = {
    once: ['once'],
    yearly: ['month', 'day', 'time'],
    monthly: ['day', 'time'],
    weekly: ['weekday', 'time'],
    daily: ['time'],
  }[valor] || [];

  $$('#modal-forma .campo[data-grupo]').forEach((nodo) => {
    const grupo = nodo.dataset.grupo;
    if (!grupo) return;
    nodo.classList.toggle('oculto', !visibles.includes(grupo));
  });
}

/** Abre el formulario de mensaje programado. */
function formularioProgramado(programado) {
  const esNuevo = !programado;

  abrirModal({
    titulo: esNuevo ? 'Programar mensaje' : 'Editar mensaje programado',
    campos: camposProgramado(programado),
    textoBoton: esNuevo ? 'Programar' : 'Guardar',
    alEnviar: async (datos) => {
      const cuerpo = {
        to: datos.to,
        title: datos.title,
        body: datos.body,
        mode: datos.mode,
        active: datos.active,
      };

      if (datos.mode === 'once') {
        if (!datos.runAt) throw new Error('Indicá la fecha y hora del envío');
        cuerpo.runAt = new Date(datos.runAt).toISOString();
      } else {
        cuerpo.time = datos.time || '09:00';
        if (datos.mode === 'yearly') cuerpo.month = Number(datos.month);
        if (datos.mode === 'yearly' || datos.mode === 'monthly') {
          cuerpo.day = Number(datos.day);
        }
        if (datos.mode === 'weekly') cuerpo.weekday = Number(datos.weekday);
      }

      if (esNuevo) await api('/api/programados', { cuerpo });
      else await api(`/api/programados/${programado.id}`, { metodo: 'PATCH', cuerpo });

      cerrarModal();
      avisar(esNuevo ? 'Mensaje programado.' : 'Mensaje actualizado.');
      await cargarProgramados();
    },
  });

  // El formulario arranca mostrando solo los campos del modo elegido.
  ajustarGruposProgramado();
  const combo = $('#campo-mode');
  if (combo) combo.addEventListener('change', ajustarGruposProgramado);
}

/** Borra un mensaje programado. */
async function borrarProgramadoDe(id) {
  const p = cache.programados.find((x) => String(x.id) === String(id));
  if (!p) return;
  if (!confirm(`¿Borrar "${p.title || String(p.body).slice(0, 30)}"?`)) return;
  await api(`/api/programados/${id}`, { metodo: 'DELETE' });
  avisar('Mensaje borrado.');
  await cargarProgramados();
}

/* =========================================================================
 * Vista: Consumo
 * ====================================================================== */

async function cargarConsumo() {
  const datos = await api('/api/consumo?dias=14');

  const usados = datos.tokens_total || 0;
  const tope = datos.tope_diario || 0;

  $('#tarjetas-consumo').innerHTML = [
    tarjeta('Llamadas a la IA', String(datos.llamadas || 0), '', `Desde ${fechaCorta(datos.desde)}`),
    tarjeta('Respuestas OK', String(datos.ok || 0), 'ok', `${datos.errores || 0} con error`),
    tarjeta('Tokens usados', String(usados), tope && usados > tope * 0.8 ? 'medio' : '', 'Hoy'),
    tarjeta(
      'Tope diario',
      tope ? String(tope) : 'Sin tope',
      '',
      tope ? `${Math.max(0, tope - usados)} disponibles` : 'No se configuró tope'
    ),
  ].join('');

  // Grafico de barras: se escala contra el dia mas alto de la serie.
  const serie = datos.serie || [];
  const maximo = Math.max(1, ...serie.map((d) => d.respuestas));

  $('#grafico-consumo').innerHTML = serie.length
    ? serie
        .map(
          (d) => `
      <div class="columna-g" title="${esc(d.dia)}: ${d.respuestas} respuestas">
        <span class="valor-g">${d.respuestas}</span>
        <div class="barra" style="height:${Math.round((d.respuestas / maximo) * 100)}%"></div>
        <span class="etiqueta-g">${esc(d.dia.slice(8, 10))}/${esc(d.dia.slice(5, 7))}</span>
      </div>`
        )
        .join('')
    : '<p class="vacio">Todavía no hay respuestas registradas.</p>';
}

/* =========================================================================
 * Arranque
 * ====================================================================== */

/** Retrasa una funcion hasta que el usuario deje de escribir. */
function conRetraso(fn, ms = 350) {
  let temporizador = null;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), ms);
  };
}

function conectarEventos() {
  /* --- Acceso -------------------------------------------------------- */
  $('#forma-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#login-error').textContent = '';
    const boton = $('#boton-entrar');
    boton.disabled = true;
    boton.textContent = 'Entrando…';

    try {
      const datos = await api('/api/login', {
        cuerpo: {
          username: $('#login-usuario').value,
          password: $('#login-clave').value,
        },
      });
      $('#login-usuario').value = '';
      $('#login-clave').value = '';
      mostrarApp(datos.usuario);
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      boton.disabled = false;
      boton.textContent = 'Entrar';
    }
  });

  $('#boton-salir').addEventListener('click', async () => {
    try {
      await api('/api/logout', { cuerpo: {} });
    } catch (_) {
      // Si la sesion ya no valia, igual hay que volver al acceso.
    }
    mostrarLogin();
  });

  /* --- Pestanas ------------------------------------------------------ */
  $('#pestanas').addEventListener('click', (ev) => {
    const boton = ev.target.closest('.pestana');
    if (boton) irAVista(boton.dataset.vista);
  });

  $$('[data-refrescar]').forEach((boton) => {
    boton.addEventListener('click', () => irAVista(boton.dataset.refrescar));
  });

  /* --- Modal --------------------------------------------------------- */
  $('#modal-cerrar').addEventListener('click', cerrarModal);
  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal') cerrarModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') cerrarModal();
  });
  $('#modal-forma').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal-cancelar') cerrarModal();
  });
  $('#modal-forma').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!alEnviarModal) return;

    const boton = $('#modal-forma button[type="submit"]');
    const textoOriginal = boton ? boton.textContent : '';
    if (boton) {
      boton.disabled = true;
      boton.textContent = 'Guardando…';
    }
    $('#modal-error').textContent = '';

    try {
      await alEnviarModal(leerModal());
    } catch (err) {
      $('#modal-error').textContent = err.message;
      if (boton) {
        boton.disabled = false;
        boton.textContent = textoOriginal;
      }
    }
  });

  /* --- Calendario ---------------------------------------------------- */
  $('#calendario').addEventListener('click', (ev) => {
    const evento = ev.target.closest('.evento');
    if (evento) {
      const encontrado = cache.eventos.find((x) => String(x._id) === evento.dataset.evento);
      if (encontrado) formularioEvento(encontrado);
      return;
    }

    const dia = ev.target.closest('.dia');
    if (dia) formularioEvento(null, dia.dataset.dia);
  });

  $('#nuevo-evento').addEventListener('click', () => formularioEvento(null));

  $('#lista-eventos').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-editar-evento]');
    if (!boton) return;
    const encontrado = cache.eventos.find(
      (x) => String(x._id) === boton.dataset.editarEvento
    );
    if (encontrado) formularioEvento(encontrado);
  });

  $('#mes-anterior').addEventListener('click', () => {
    const base = cache.mesCalendario;
    cache.mesCalendario = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    cargarCalendario().catch((err) => avisar(err.message, true));
  });
  $('#mes-siguiente').addEventListener('click', () => {
    const base = cache.mesCalendario;
    cache.mesCalendario = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    cargarCalendario().catch((err) => avisar(err.message, true));
  });
  $('#mes-hoy').addEventListener('click', () => {
    cache.mesCalendario = new Date();
    cargarCalendario().catch((err) => avisar(err.message, true));
  });

  /* --- Tablero ------------------------------------------------------- */
  conectarKanban();

  $('#nueva-tarea').addEventListener('click', () => formularioTarea(null));

  $('#kanban').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-editar-tarea]');
    if (!boton) return;
    const encontrada = cache.tareas.find(
      (x) => String(x._id) === boton.dataset.editarTarea
    );
    if (encontrada) formularioTarea(encontrada);
  });

  // Doble clic sobre una tarjeta tambien abre el formulario.
  $('#kanban').addEventListener('dblclick', (ev) => {
    const tarjeta = ev.target.closest('.tarjeta-tarea');
    if (!tarjeta || ev.target.closest('button')) return;
    const encontrada = cache.tareas.find((x) => String(x._id) === tarjeta.dataset.tarea);
    if (encontrada) formularioTarea(encontrada);
  });

  $('#filtro-tareas').addEventListener(
    'input',
    conRetraso((ev) => {
      cache.filtros.tareas = ev.target.value.trim();
      cargarTablero().catch((err) => avisar(err.message, true));
    })
  );

  $('#filtro-responsable').addEventListener('change', (ev) => {
    cache.filtros.responsable = ev.target.value;
    cargarTablero().catch((err) => avisar(err.message, true));
  });

  /* --- Mensajes ------------------------------------------------------ */
  $('#lista-conversaciones').addEventListener('click', (ev) => {
    const charla = ev.target.closest('.charla');
    if (!charla) return;
    cache.conversacionActiva = charla.dataset.charla;
    pintarConversaciones();
    pintarHilo(cache.conversacionActiva).catch((err) => avisar(err.message, true));
  });

  $('#buscar-mensajes').addEventListener(
    'input',
    conRetraso((ev) => {
      cache.filtros.mensajes = ev.target.value.trim();
      if (cache.conversacionActiva) {
        pintarHilo(cache.conversacionActiva).catch((err) => avisar(err.message, true));
      }
    })
  );

  $('#filtro-direccion').addEventListener('change', (ev) => {
    cache.filtros.direccion = ev.target.value;
    if (cache.conversacionActiva) {
      pintarHilo(cache.conversacionActiva).catch((err) => avisar(err.message, true));
    }
  });

  /* --- Contactos ----------------------------------------------------- */
  $('#nuevo-contacto').addEventListener('click', () => formularioContacto(null));

  $('#tabla-contactos').addEventListener('click', (ev) => {
    const editar = ev.target.closest('[data-editar-contacto]');
    if (editar) {
      const c = cache.contactos.find((x) => String(x.id) === editar.dataset.editarContacto);
      if (c) formularioContacto(c);
      return;
    }
    const borrar = ev.target.closest('[data-borrar-contacto]');
    if (borrar) {
      borrarContactoDe(borrar.dataset.borrarContacto).catch((err) =>
        avisar(err.message, true)
      );
    }
  });

  $('#buscar-contactos').addEventListener(
    'input',
    conRetraso((ev) => {
      cache.filtros.contacto = ev.target.value.trim();
      cargarContactos().catch((err) => avisar(err.message, true));
    })
  );

  /* --- Programados --------------------------------------------------- */
  $('#nuevo-programado').addEventListener('click', () => formularioProgramado(null));

  $('#lista-programados').addEventListener('click', (ev) => {
    const editar = ev.target.closest('[data-editar-programado]');
    if (editar) {
      const p = cache.programados.find(
        (x) => String(x.id) === editar.dataset.editarProgramado
      );
      if (p) formularioProgramado(p);
      return;
    }
    const borrar = ev.target.closest('[data-borrar-programado]');
    if (borrar) {
      borrarProgramadoDe(borrar.dataset.borrarProgramado).catch((err) =>
        avisar(err.message, true)
      );
    }
  });

  /* --- Refresco automatico ------------------------------------------- */
  // El codigo de vinculacion cambia cada pocos minutos: con el panel abierto
  // en la pantalla de inicio, se refresca solo para mostrar el vigente.
  setInterval(() => {
    if (document.hidden || !cache.usuario) return;
    if ($('#vista-panel').classList.contains('activa')) {
      cargarPanel().catch(() => {});
    }
  }, 45000);
}

conectarEventos();
comprobarSesion();


