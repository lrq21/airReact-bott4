require('dotenv').config();
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, AttachmentBuilder, PermissionFlagsBits, MessageFlags,
  TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SlashCommandBuilder,
} = require('discord.js');

// ---------- CONFIG ----------
const GUILD_ID = '1547387310654361705';
const SOURCE_ID = '1564397514361278616'; // canal donde suben imágenes
const TARGET_ID = '1564398515021676694'; // canal donde se publican las de 10+ reacciones
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
const pending = new Map();
let runtimeErrors = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ZW = '\u200b'; // caracter invisible: guarda el nº de imagen para no duplicar posts

const isImage = a => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '');
const imageSources = m => {
  const attachments = [...m.attachments.values()]
    .filter(isImage)
    .map(attachment => ({ url: attachment.url, name: attachment.name || '' }));
  const embeds = m.embeds.flatMap(embed => [embed.image?.url, embed.thumbnail?.url]
    .filter(Boolean)
    .map(url => ({ url, name: '' })));
  return [...new Map([...attachments, ...embeds].map(image => [image.url, image])).values()].slice(0, 10);
};
const countReactions = m => m.reactions.cache.reduce((count, reaction) => count + reaction.count, 0);

async function countUniqueReactors(msg) {
  const users = new Set();
  for (const reaction of msg.reactions.cache.values()) {
    let after;
    while (true) {
      const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
      for (const user of page.values()) users.add(user.id);
      if (page.size < 100 || users.size >= THRESHOLD) break;
      after = page.last()?.id;
      if (!after) break;
    }
    if (users.size >= THRESHOLD) break;
  }
  return users.size;
}

function recordError(context, error) {
  runtimeErrors++;
  console.error(`${context}:`, error.message);
}

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
    const urlPath = new URL(imgs[i].url).pathname;
    const ext = /\.([a-z0-9]{2,5})$/i.exec(imgs[i].name || '')?.[1]
      || /\.([a-z0-9]{2,5})$/i.exec(urlPath)?.[1]
      || 'png';
    const file = new AttachmentBuilder(Buffer.from(await r.arrayBuffer()), { name: `${src.id}_${i + 1}.${ext}` });
    return await ch.send({ ...payload(src, i, `attachment://${file.name}`), files: [file] });
  } catch {
    // si no se puede re-subir (peso, error), usa el link original
    return await ch.send(payload(src, i, imgs[i].url));
  }
}

// Lee los últimos posts del bot para saber qué imágenes ya se publicaron
async function loadPosted(fullHistory = false) {
  const ch = await client.channels.fetch(TARGET_ID);
  let before;
  do {
    const msgs = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
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
    before = msgs.last()?.id;
    if (!fullHistory || msgs.size < 100) break;
  } while (true);
}

async function handle(msg) {
  if (msg.guildId !== GUILD_ID || msg.channelId !== SOURCE_ID) return;
  if (!msg.author || msg.author.bot) return;
  const imgs = imageSources(msg);
  const totalReactions = countReactions(msg);
  console.log(`[scan] message ${msg.id}: attachments=${msg.attachments.size}, embeds=${msg.embeds.length}, images=${imgs.length}, reactions=${totalReactions}`);
  if (!imgs.length) return;
  if (busy.has(msg.id)) {
    pending.set(msg.id, msg);
    return;
  }
  if (totalReactions < THRESHOLD) {
    console.log(`[reactions] message ${msg.id}: ${totalReactions} total reactions, needs ${THRESHOLD}; skipped`);
    return;
  }
  busy.add(msg.id);
  try {
    const count = await countUniqueReactors(msg);
    console.log(`[reactions] message ${msg.id}: ${count}/${THRESHOLD} unique users (${totalReactions} total reactions)`);
    if (count < THRESHOLD) {
      console.log(`[reactions] message ${msg.id}: skipped; duplicate emoji reactions do not add users`);
      return;
    }
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
    recordError('handle', e);
  } finally {
    busy.delete(msg.id);
    const queued = pending.get(msg.id);
    if (queued) {
      pending.delete(msg.id);
      await handle(queued);
    }
  }
}

async function onReaction(reaction) {
  try {
    if (reaction.partial) reaction = await reaction.fetch();
    let msg = reaction.message;
    if (msg.partial) msg = await msg.fetch();
    console.log(`[reaction-add] message ${msg.id}, emoji ${reaction.emoji.name || reaction.emoji.id}`);
    await handle(msg);
  } catch (e) {
    recordError('reaction', e);
  }
}

async function sweep(fullHistory = false) {
  try {
    console.log(`[sweep] starting ${fullHistory ? 'full-history recovery' : 'recent-message check'}`);
    const src = await client.channels.fetch(SOURCE_ID);
    await loadPosted(fullHistory);
    let before;
    let scanned = 0;
    do {
      const msgs = await src.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!msgs.size) break;
      scanned += msgs.size;
      for (const m of [...msgs.values()].reverse()) await handle(m);
      before = msgs.last()?.id;
      if (!fullHistory || msgs.size < 100) break;
    } while (true);
    console.log(`[sweep] finished; scanned ${scanned} source messages`);
  } catch (e) {
    recordError('sweep', e);
  }
}

// Revisa permisos del bot en los dos canales y lo deja escrito en los logs de Render
async function diagnose() {
  let permissionIssues = 0;
  let errors = 0;
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
      permissionIssues += missing.length;
      console.log(`[check] ${name} #${ch.name}: ${missing.length ? 'MISSING ' + missing.join(', ') : 'OK'}`);
    } catch (e) {
      errors++;
      console.log(`[check] ${name}: cannot access channel (${e.message})`);
    }
  }
  return { permissionIssues, errors };
}

const reactCommand = new SlashCommandBuilder()
  .setName('react')
  .setDescription('Estado del bot')
  .addSubcommand(subcommand => subcommand
    .setName('status')
    .setDescription('Comprueba el estado del bot'));

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'react') return;
    if (interaction.guildId !== GUILD_ID || interaction.options.getSubcommand() !== 'status') return;

    await interaction.deferReply();
    const status = await diagnose();
    const errors = runtimeErrors + status.errors;
    const response = errors > 0
      ? `Status 🔴 msg: ${errors} Check me urgent!`
      : status.permissionIssues > 0
        ? 'Status 🟠 msg: check me'
        : 'Status 🟢 msg: all good';
    await interaction.editReply(response);
    setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
  } catch (e) {
    recordError('command', e);
  }
});

client.on('messageReactionAdd', onReaction);

client.once('clientReady', async () => {
  console.log(`Online as ${client.user.tag}`);
  try {
    await client.application.commands.create(reactCommand, GUILD_ID);
  } catch (e) {
    recordError('slash command registration', e);
  }
  diagnose().then(() => sweep(true));
  setInterval(() => sweep(), SWEEP_MS);
});

client.login(TOKEN).catch(e => { console.error('Login failed:', e.message); process.exit(1); });
