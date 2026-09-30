'use strict';
// OrbitaOs - gestion de la lista blanca desde la linea de comandos.

require('dotenv').config();

const db = require('../src/database');
const users = require('../src/users');

const AYUDA = `
Lista blanca de OrbitaOs

  list                       muestra los contactos con acceso
  add <numero> [--name N]    agrega un contacto y le da acceso
      --user <usuario>        lo asocia a un usuario existente
      --role owner|admin|member
      [--phone <numero>]      (alias de <numero>)
  remove <numero>            quita el acceso de un contacto
  allow <numero>             reactiva el acceso
  block <numero>             desactiva el acceso sin borrarlo
`.trim();

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
  // Acepta tanto `add 549...` como `add --phone 549...`.
  const phone = users.normalizePhone(pos[0] || flags.phone || '');

  switch (comando) {
    case 'list': {
      const lista = await db.User.find({ phone: { $ne: null } })
        .sort({ phone: 1 })
        .lean();
      if (!lista.length) {
        console.log('\nNo hay contactos en la lista blanca.');
        console.log('Agrega uno con: npm run whitelist -- add 54911123456789\n');
        break;
      }
      console.log('\nTELEFONO        ACCESO  ROL     NOMBRE');
      console.log('-'.repeat(62));
      for (const u of lista) {
        console.log(
          `${u.phone.padEnd(15)} ${(u.allowed ? 'si' : 'NO').padEnd(7)} ` +
          `${String(u.role).padEnd(7)} ${u.name || '-'}`
        );
      }
      console.log('');
      break;
    }

    case 'add': {
      if (!phone) {
        console.error('Uso: add <numero> [--name "Nombre"] [--role admin]');
        process.exit(1);
      }

      // Si ya existe ese telefono, se actualiza en vez de duplicar.
      const existente = await db.User.findOne({ phone }).lean();
      const patch = { phone, allowed: true };
      if (flags.name) patch.name = flags.name;
      if (flags.role) patch.role = flags.role;

      if (existente) {
        await db.User.updateOne({ phone }, { $set: patch });
        console.log(`Actualizado: ${phone} (acceso: si)`);
        if (flags.user) {
          await db.User.updateOne(
            { username: users.normalizeUsername(flags.user) },
            { $set: { phone, allowed: true } }
          );
          console.log(`Vinculado al usuario "${flags.user}"`);
        }
        break;
      }

      if (flags.user) {
        // Asocia el telefono a un usuario ya creado.
        const u = await db.User.findOneAndUpdate(
          { username: users.normalizeUsername(flags.user) },
          { $set: { phone, allowed: true, ...(flags.name ? { name: flags.name } : {}) } },
          { new: true }
        );
        if (!u) {
          console.error(`No existe el usuario "${flags.user}"`);
          process.exitCode = 1;
          break;
        }
        console.log(`${u.username} ahora tiene acceso desde ${phone}`);
        break;
      }

      // Contacto nuevo, sin cuenta de acceso al panel: solo WhatsApp.
      await db.User.create({
        username: `wa${phone}`,
        passwordHash: 'sin-acceso-por-whatsapp',
        phone,
        name: flags.name || '',
        role: ['owner', 'admin', 'member'].includes(flags.role) ? flags.role : 'member',
        allowed: true,
      });
      console.log(`Agregado: ${phone} con acceso al bot`);
      if (flags.name) console.log(`Nombre: ${flags.name}`);
      break;
    }

    case 'remove': {
      if (!phone) {
        console.error('Uso: remove <numero>');
        process.exit(1);
      }
      const r = await db.User.deleteOne({ phone });
      console.log(
        r.deletedCount
          ? `Eliminado: ${phone}`
          : `No habia ningun contacto con ${phone}`
      );
      break;
    }

    case 'allow':
    case 'block': {
      if (!phone) {
        console.error(`Uso: ${comando} <numero>`);
        process.exit(1);
      }
      const r = await db.User.updateOne(
        { phone },
        { $set: { allowed: comando === 'allow' } }
      );
      console.log(
        r.matchedCount
          ? `${phone}: acceso ${comando === 'allow' ? 'habilitado' : 'deshabilitado'}`
          : `No hay contacto con ${phone}. Agregalo primero con: add ${phone}`
      );
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
