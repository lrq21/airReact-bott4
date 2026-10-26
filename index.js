require('dotenv').config();
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');

// ---------- CONFIG ----------
const GUILD_ID = '1547387310654361705';
const SOURCE_ID = '1564398515021676694'; // canal donde suben imágenes
const TARGET_ID = '1564397514361278616'; // canal donde se publican las de 10+ reacciones
const THRESHOLD = 2;                    // reacciones necesarias (producción: 10)
const EMOJI = '💫';
const COLOR = 0xf0b232;                 // color de la barra del embed
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
    GatewayIntentBits.MessageContent, // necesario para leer adjuntos y el texto del mensaje
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const posted = new Map(); // "idMensajeOriginal:nºImagen" -> mensaje publicado por el bot
const busy = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const isImage = a => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '');
const imageAttachments = m => [...m.attachments.values()].filter(isImage).slice(0, 10);
const countReactions = m => m.reactions.cache.reduce((n, r) => n + r.count, 0);
const header = count => `${EMOJI} **${count}** <#${SOURCE_ID}>`;

// Texto de posts antiguos (formato anterior) para no duplicarlos
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

// Avatar + nombre que se muestra en el servidor (apodo > nombre global > usuario)
async function resolveAuthor(src) {
  const member = await src.guild.members.fetch(src.author.id).catch(() => null);
  const u = src.author;
  return {
    name: member?.displayName || u.globalName || u.username,
    icon: (member || u).displayAvatarURL({ size: 128 }),
  };
}

function buildEmbed(src, author, i, total) {
  const text = (src.content || '').trim().slice(0, 3000);
  const description = `${text ? text + '\n\n' : ''}[Jump There!](${src.url})`;
  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: author.name, iconURL: author.icon })
    .setDescription(description)
    .setFooter({ text: total > 1 ? `${src.id} (${i + 1}/${total})` : src.id })
    .setTimestamp(src.createdAt);
}

async function createPost(src, imgs, i, count, author) {
  const ch = await client.channels.fetch(TARGET_ID);
  const embed = buildEmbed(src, author, i, imgs.length);
  try {
    // Re-sube la imagen para que siga existiendo aunque borren el original
    const r = await fetch(imgs[i].url);
    if (!r.ok) throw new Error('download failed');
    const ext = ((imgs[i].name || '').split('.').pop() || 'png').toLowerCase();
    const file = new AttachmentBuilder(Buffer.from(await r.arrayBuffer()), { name: `image.${ext}` });
    embed.setImage(`attachment://${file.name}`);
    return await ch.send({ content: header(count), embeds: [embed], files: [file] });
  } catch {
    // si no se puede re-subir (peso, error), usa el link original
    embed.setImage(imgs[i].url);
    return await ch.send({ content: header(count), embeds: [embed] });
  }
}

async function updatePost(key, post, count) {
  if (!post.embeds.length) return; // post antiguo, no se edita
  const m = /\*\*(\d+)\*\*/.exec(post.content || '');
  if (m && Number(m[1]) === count) return;
  posted.set(key, await post.edit({ content: header(count) }));
}

async function loadPosted() {
  const ch = await client.channels.fetch(TARGET_ID);
  const msgs = await ch.messages.fetch({ limit: 100 });
  for (const m of msgs.values()) {
    if (m.author.id !== client.user.id) continue;
    let key;
    const f = /^(\d{17,20})(?: \((\d+)\/\d+\))?$/.exec(m.embeds[0]?.footer?.text || '');
    if (f) key = `${f[1]}:${f[2] || 1}`;
    else {
      const old = /(\d{17,20}) \| <t:/.exec(textOf(m));
      if (old) key = `${old[1]}:1`;
    }
    if (key) posted.set(key, m);
  }
}

async function handle(msg, loaded = false) {
  if (msg.guildId !== GUILD_ID || msg.channelId !== SOURCE_ID) return;
  if (!msg.author || msg.author.bot) return;
  const imgs = imageAttachments(msg);
  if (!imgs.length) return;
  if (busy.has(msg.id)) return;
  busy.add(msg.id);
  try {
    const count = countReactions(msg);
    const keyOf = i => `${msg.id}:${i + 1}`;
    if (count >= THRESHOLD && !loaded && imgs.some((_, i) => !posted.has(keyOf(i)))) await loadPosted();

    // actualiza el contador de los posts que ya existen
    for (let i = 0; i < imgs.length; i++) {
      const post = posted.get(keyOf(i));
      if (post) await updatePost(keyOf(i), post, count);
    }

    // publica las imágenes que faltan, cada una en su propio mensaje
    if (count >= THRESHOLD) {
      let author = null;
      for (let i = 0; i < imgs.length; i++) {
        if (posted.has(keyOf(i))) continue;
        author = author || await resolveAuthor(msg);
        posted.set(keyOf(i), await createPost(msg, imgs, i, count, author));
        console.log(`[post] ${msg.id} image ${i + 1}/${imgs.length} published with ${count} reactions`);
        await sleep(500);
      }
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
    ['target', TARGET_ID, ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles']],
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
