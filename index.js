require('dotenv').config();
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, AttachmentBuilder, PermissionFlagsBits, MessageFlags,
  TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
} = require('discord.js');

// ---------- CONFIG ----------
const GUILD_ID = '1547387310654361705';
const SOURCE_ID = '1564398515021676694'; // canal donde suben imágenes
const TARGET_ID = '1564397514361278616'; // canal donde se publican las de 10+ reacciones
const THRESHOLD = 10;                    // reacciones necesarias (producción: 10)
const MESSAGE = '/pickme Salon de la Fama 🌟';   // mensaje corto debajo de "Source"
const LINK_TEXT = 'Go there!';          // texto del link que lleva al mensaje original
const SWEEP_MS = 5 * 60 * 1000;         // revisión periódica (por si el bot estuvo dormido)
// -----------------------------

const TOKEN = process.env.TOKEN;
if (!TOKEN) { console.error('Missing TOKEN env variable'); process.exit(1); }

// Servidor web mínimo: Render (plan gratis) solo acepta Web Services y los duerme sin tráfico
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {}); }, 10 * 60 * 1000);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, // necesario para leer los adjuntos
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const posted = new Map(); // "idMensajeOriginal:nºImagen" -> mensaje publicado por el bot
const busy = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ZW = '\u200b'; // caracter invisible: guarda el nº de imagen para no duplicar posts

const isImage = a => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '');
const imageAttachments = m => [...m.attachments.values()].filter(isImage).slice(0, 10);
const countReactions = m => m.reactions.cache.reduce((n, r) => n + r.count, 0);

function textOf(m) {
  const out = [];
  const walk = list => {
    for (const c of list || []) {
      if (typeof c.content === 'string') out.push(c.content);
      if (c.components) walk(c.components);
    }
  };
  walk(m.components);
  return out.join('\n');
}

// Source #canal @usuario / mensaje corto / Go there! / imagen / fecha y hora exacta
function payload(src, i, imageUrl) {
  const ts = Math.floor(src.createdTimestamp / 1000);
  const msg = MESSAGE[0] + ZW.repeat(i + 1) + MESSAGE.slice(1);
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      new TextDisplayBuilder().setContent(
        `**Source** <#${SOURCE_ID}> <@${src.author.id}>\n${msg}\n[${LINK_TEXT}](${src.url})`
      ),
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl)),
      new TextDisplayBuilder().setContent(`<t:${ts}:F>`),
    ],
  };
}

async function createPost(src, imgs, i) {
  const ch = await client.channels.fetch(TARGET_ID);
  try {
    // Re-sube la imagen para que siga existiendo aunque borren el original.
    // El nombre del archivo guarda la clave del post (id_nº) para no duplicarlo nunca.
    const r = await fetch(imgs[i].url);
    if (!r.ok) throw new Error('download failed');
    const ext = ((imgs[i].name || '').split('.').pop() || 'png').toLowerCase();
    const file = new AttachmentBuilder(Buffer.from(await r.arrayBuffer()), { name: `${src.id}_${i + 1}.${ext}` });
    return await ch.send({ ...payload(src, i, `attachment://${file.name}`), files: [file] });
  } catch {
    // si no se puede re-subir (peso, error), usa el link original
    return await ch.send(payload(src, i, imgs[i].url));
  }
}

// Lee los últimos posts del bot para saber qué imágenes ya se publicaron
async function loadPosted() {
  const ch = await client.channels.fetch(TARGET_ID);
  const msgs = await ch.messages.fetch({ limit: 100 });
  for (const m of msgs.values()) {
    if (m.author.id !== client.user.id) continue;
    const text = textOf(m);
    const att = [...m.attachments.values()].map(x => /^(\d{17,20})_(\d+)\./.exec(x.name || '')).find(Boolean);
    const link = /channels\/\d+\/\d+\/(\d{17,20})/.exec(text);
    const old = /(\d{17,20}) \| <t:/.exec(text);
    const zw = (text.match(/\u200b/g) || []).length;
    let key;
    if (att) key = `${att[1]}:${att[2]}`;
    else if (link) key = `${link[1]}:${zw || 1}`;
    else if (old) key = `${old[1]}:1`;
    if (key) posted.set(key, m);
  }
}

async function handle(msg) {
  if (msg.guildId !== GUILD_ID || msg.channelId !== SOURCE_ID) return;
  if (!msg.author || msg.author.bot) return;
  const imgs = imageAttachments(msg);
  if (!imgs.length) return;
  if (busy.has(msg.id)) return;
  busy.add(msg.id);
  try {
    const count = countReactions(msg);
    if (count < THRESHOLD) return;
    const keyOf = i => `${msg.id}:${i + 1}`;
    if (imgs.some((_, i) => !posted.has(keyOf(i)))) await loadPosted();

    // cada imagen sale en su propio mensaje
    for (let i = 0; i < imgs.length; i++) {
      if (posted.has(keyOf(i))) continue;
      posted.set(keyOf(i), await createPost(msg, imgs, i));
      console.log(`[post] ${msg.id} image ${i + 1}/${imgs.length} published with ${count} reactions`);
      await sleep(500);
    }
  } catch (e) {
    console.error('handle:', e.message);
  } finally {
    busy.delete(msg.id);
  }
}

async function onReaction(reaction) {
  try {
    if (reaction.partial) reaction = await reaction.fetch();
    let msg = reaction.message;
    if (msg.partial) msg = await msg.fetch();
    await handle(msg);
  } catch (e) {
    console.error('reaction:', e.message);
  }
}

async function sweep() {
  try {
    const src = await client.channels.fetch(SOURCE_ID);
    const msgs = await src.messages.fetch({ limit: 100 });
    await loadPosted();
    for (const m of [...msgs.values()].reverse()) await handle(m);
  } catch (e) {
    console.error('sweep:', e.message);
  }
}

// Revisa permisos del bot en los dos canales y lo deja escrito en los logs de Render
async function diagnose() {
  const checks = [
    ['source', SOURCE_ID, ['ViewChannel', 'ReadMessageHistory']],
    ['target', TARGET_ID, ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'AttachFiles']],
  ];
  for (const [name, id, need] of checks) {
    try {
      const ch = await client.channels.fetch(id);
      const me = await ch.guild.members.fetchMe();
      const perms = ch.permissionsFor(me);
      const missing = need.filter(p => !perms.has(PermissionFlagsBits[p]));
      console.log(`[check] ${name} #${ch.name}: ${missing.length ? 'MISSING ' + missing.join(', ') : 'OK'}`);
    } catch (e) {
      console.log(`[check] ${name}: cannot access channel (${e.message})`);
    }
  }
}

// Comando "!react msg": responde "AirReact Here!" (se borra solo) y, en tu servidor, fuerza una revisión
let lastRun = 0;
client.on('messageCreate', async msg => {
  try {
    if (msg.author.bot || !msg.guild) return;
    if (!/^!react(\s+msg)?$/i.test(msg.content.trim())) return;

    const reply = await msg.channel.send('AirReact Here!');
    setTimeout(() => reply.delete().catch(() => {}), 5000);

    if (msg.guildId === GUILD_ID && Date.now() - lastRun > 30000) {
      lastRun = Date.now();
      await diagnose();
      sweep();
    }
  } catch (e) {
    console.error('command:', e.message);
  }
});

client.on('messageReactionAdd', onReaction);
client.on('messageReactionRemove', onReaction);

client.once('clientReady', () => {
  console.log(`Online as ${client.user.tag}`);
  diagnose().then(sweep);
  setInterval(sweep, SWEEP_MS);
});

client.login(TOKEN).catch(e => { console.error('Login failed:', e.message); process.exit(1); });
