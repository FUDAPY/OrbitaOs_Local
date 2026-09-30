'use strict';
// OrbitaOs - CLI de gestion de usuarios.

require('dotenv').config();

const db = require('../src/database');
const users = require('../src/users');

/** Extrae las banderas --clave valor de los argumentos. */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const AYUDA = `
Gestor de usuarios de OrbitaOs

  list                                 lista todos los usuarios
  create <usuario> <clave>             crea un usuario
      --phone <numero>                 lo autoriza en WhatsApp
      --name "Nombre visible"          nombre para mostrar
      --role owner|admin|member        rol (por defecto member)
  rename <usuario> "Nuevo nombre"      cambia el nombre visible
  pass <usuario> <nueva-clave>         cambia la contrasena
  delete <usuario> [--force]           elimina un usuario
  login <usuario> <clave>              verifica una contrasena
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  const comando = argv[0];

  if (!comando || comando === 'help' || comando === '--help') {
    console.log(AYUDA);
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Falta MONGO_URI en el entorno.');
    process.exit(1);
  }
  await db.connect(uri);

  const { flags, pos } = parseArgs(argv.slice(1));

  switch (comando) {
    case 'list': {
      const lista = await users.listUsers();
      if (!lista.length) {
        console.log('No hay usuarios.');
        break;
      }
      console.log('\nUSUARIO              ROL      TELEFONO        NOMBRE');
      console.log('-'.repeat(70));
      for (const u of lista) {
        console.log(
          `${String(u.username).padEnd(20)} ${String(u.role).padEnd(8)} ` +
          `${String(u.phone || '-').padEnd(15)} ${u.name || '-'}`
        );
      }
      console.log('');
      break;
    }

    case 'create': {
      const [username, password] = pos;
      if (!username || !password) {
        console.error('Uso: create <usuario> <clave> [--phone <numero>]');
        process.exit(1);
      }
      const u = await users.createUser({
        username,
        password,
        phone: flags.phone,
        name: flags.name,
        role: flags.role,
      });
      console.log(`Usuario creado: ${u.username} (${u.role})`);
      if (u.phone) console.log(`WhatsApp habilitado: ${u.phone}`);
      break;
    }

    case 'rename': {
      const [username, name] = pos;
      if (!username || !name) {
        console.error('Uso: rename <usuario> "Nuevo nombre"');
        process.exit(1);
      }
      const u = await users.renameUser(username, name);
      console.log(`"${u.username}" ahora se llama "${u.name}"`);
      break;
    }

    case 'pass': {
      const [username, password] = pos;
      if (!username || !password) {
        console.error('Uso: pass <usuario> <nueva-clave>');
        process.exit(1);
      }
      await users.changePassword(username, password);
      console.log(`Contrasena actualizada para "${username}"`);
      break;
    }

    case 'delete': {
      const [username] = pos;
      if (!username) {
        console.error('Uso: delete <usuario> [--force]');
        process.exit(1);
      }
      const r = await users.deleteUser(username, { force: Boolean(flags.force) });
      console.log(`Usuario eliminado: ${r.username}`);
      break;
    }

    case 'login': {
      const [username, password] = pos;
      if (!username || !password) {
        console.error('Uso: login <usuario> <clave>');
        process.exit(1);
      }
      const u = await users.authenticate(username, password);
      console.log(u ? `OK. Bienvenido ${u.name || u.username}.` : 'Credenciales invalidas.');
      process.exitCode = u ? 0 : 1;
      break;
    }

    default:
      console.error(`Comando desconocido: ${comando}\n`);
      console.log(AYUDA);
      process.exitCode = 1;
  }

  await db.disconnect();
}

main().catch(async (err) => {
  console.error(`Error: ${err.message}`);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
