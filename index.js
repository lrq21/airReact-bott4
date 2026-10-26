require('dotenv').config();
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, AttachmentBuilder,
  TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

// ---------- CONFIG ----------
const GUILD_ID = '1547387310654361705';
const SOURCE_ID = '1564131639158775818'; // canal donde suben imágenes
const TARGET_ID = '1564143120713785344'; // canal donde se publican las de 10+ reacciones
const THRESHOLD = 10;
const EMOJI = '💫';
const SWEEP_MS = 5 * 60 * 1000; // revisión periódica (por si el bot estuvo dormido)
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

const posted = new Map(); // id del mensaje original -> mensaje publicado
const busy = new Set();

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

function build(src, count, urls) {
  const ts = Math.floor(src.createdTimestamp / 1000);
  return [
    new TextDisplayBuilder().setContent(
      `${EMOJI} **${count}** <#${SOURCE_ID}>\n<@${src.author.id}>\n**Source**\n[Jump!](${src.url})`
    ),
    new MediaGalleryBuilder().addItems(urls.map(u => new MediaGalleryItemBuilder().setURL(u))),
    new TextDisplayBuilder().setContent(`${src.id} | <t:${ts}:F>`),
  ];
}

const opts = (components, files) => ({
  flags: MessageFlags.IsComponentsV2,
  allowedMentions: { parse: [] },
  components,
  ...(files ? { files } : {}),
});

async function createPost(src, count) {
  const imgs = imageAttachments(src);
  const ch = await client.channels.fetch(TARGET_ID);
  try {
    // Re-sube las imágenes para que sigan existiendo aunque borren el original
    const files = [];
    for (let i = 0; i < imgs.length; i++) {
      const r = await fetch(imgs[i].url);
      if (!r.ok) throw new Error('download failed');
      const ext = (imgs[i].name || '').split('.').pop() || 'png';
      files.push(new AttachmentBuilder(Buffer.from(await r.arrayBuffer()), { name: `img${i + 1}.${ext}` }));
    }
    return await ch.send(opts(build(src, count, files.map(f => `attachment://${f.name}`)), files));
  } catch {
    // si no se puede re-subir (peso, error), usa los links originales
    return await ch.send(opts(build(src, count, imgs.map(a => a.url))));
  }
}

async function updatePost(post, src, count) {
  const m = /\*\*(\d+)\*\*/.exec(textOf(post));
  if (m && Number(m[1]) === count) return;
  const names = [...post.attachments.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(a => `attachment://${a.name}`);
  const urls = names.length ? names : imageAttachments(src).map(a => a.url);
  posted.set(src.id, await post.edit(opts(build(src, count, urls))));
}

async function loadPosted() {
  const ch = await client.channels.fetch(TARGET_ID);
  const msgs = await ch.messages.fetch({ limit: 100 });
  for (const m of msgs.values()) {
    if (m.author.id !== client.user.id) continue;
    const id = /(\d{17,20}) \| <t:/.exec(textOf(m))?.[1];
    if (id) posted.set(id, m);
  }
}

async function handle(msg, loaded = false) {
  if (msg.guildId !== GUILD_ID || msg.channelId !== SOURCE_ID) return;
  if (!msg.author || msg.author.bot) return;
  if (!imageAttachments(msg).length) return;
  if (busy.has(msg.id)) return;
  busy.add(msg.id);
  try {
    const count = countReactions(msg);
    let post = posted.get(msg.id);
    if (!post && count >= THRESHOLD) {
      if (!loaded) await loadPosted();
      post = posted.get(msg.id);
    }
    if (post) await updatePost(post, msg, count);
    else if (count >= THRESHOLD) {
      posted.set(msg.id, await createPost(msg, count));
      console.log(`[post] ${msg.id} published with ${count} reactions`);
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
    for (const m of [...msgs.values()].reverse()) await handle(m, true);
  } catch (e) {
    console.error('sweep:', e.message);
  }
}

// Revisa permisos del bot en los dos canales y lo deja escrito en los logs de Render
async function diagnose() {
  const checks = [
    ['source', SOURCE_ID, ['ViewChannel', 'ReadMessageHistory']],
    ['target', TARGET_ID, ['ViewChannel', 'SendMessages', 'AttachFiles']],
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
