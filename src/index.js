require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
  MessageFlags
} = require("discord.js");

const {
  createPost,
  getPost,
  getPostByMessage,
  toggleLike,
  getLikeCount,
  addComment,
  getComments,
  getCommentCount,
  updatePostMedia
} = require("./database");


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],

  partials: [
    Partials.Message,
    Partials.Channel
  ]
});

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÃO
|--------------------------------------------------------------------------
*/

const FEED_CHANNEL_ID = process.env.FEED_CHANNEL_ID;

const COLOR = 0xff5c00;

const EMOJI_LIKE_ID = "1548500556560208032";
const EMOJI_COMMENT_ID = "1548500558850170970";
const EMOJI_VIEW_COMMENTS_ID = "1548500557638148146";

/*
|--------------------------------------------------------------------------
| DETECTA TIPO DE MÍDIA
|--------------------------------------------------------------------------
*/

function isImageMedia(mediaType, mediaUrlOrName) {
  return Boolean(
    mediaType?.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(mediaUrlOrName || "")
  );
}

function isVideoMedia(mediaType, mediaUrlOrName) {
  return Boolean(
    mediaType?.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi)(\?.*)?$/i.test(mediaUrlOrName || "")
  );
}

// Um anexo que passou pelo nosso re-upload (attachment:// temporário, ou
// já a URL final do CDN do próprio Discord) — diferente de um link
// externo que o usuário só colou no texto.
function isUploadedFile(url) {
  return Boolean(
    url && (
      url.startsWith("attachment://") ||
      /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(url)
    )
  );
}

/*
|--------------------------------------------------------------------------
| BOT ONLINE
|--------------------------------------------------------------------------
*/

client.once("clientReady", () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  if (FEED_CHANNEL_ID) {
    console.log(`📸 Canal do feed: ${FEED_CHANNEL_ID}`);
  } else {
    console.log(
      "⚠️ FEED_CHANNEL_ID não configurado. O bot poderá funcionar em qualquer canal."
    );
  }
});

/*
|--------------------------------------------------------------------------
| NOVA MENSAGEM
|--------------------------------------------------------------------------
*/

client.on("messageCreate", async (message) => {
  console.log(
    `📨 Mensagem recebida: ${message.author.tag} | Canal: ${message.channel.id}`
  );

  try {
    // Ignora bots
    if (message.author.bot) return;

    // Ignora DMs
    if (!message.guild) return;

    // Se configurou um canal específico,
    // somente mensagens desse canal viram posts.
    if (
      FEED_CHANNEL_ID &&
      message.channel.id !== FEED_CHANNEL_ID
    ) {
      return;
    }

    /*
    |--------------------------------------------------------------------------
    | PEGA O CONTEÚDO
    |--------------------------------------------------------------------------
    */

    const content = message.content?.trim() || "";

    /*
    |--------------------------------------------------------------------------
    | PEGA O PRIMEIRO ANEXO
    |--------------------------------------------------------------------------
    */

    let mediaUrl = null;
    let mediaType = null;
    let sourceAttachment = null;

    if (message.attachments.size > 0) {
      const attachment = message.attachments.first();

      mediaUrl = attachment.url;
      mediaType = attachment.contentType || "";
      sourceAttachment = attachment;
    }

    /*
    |--------------------------------------------------------------------------
    | PEGA LINK SE NÃO HOUVER ANEXO
    |--------------------------------------------------------------------------
    */

    if (!mediaUrl && content) {
      const urlMatch = content.match(
        /(https?:\/\/[^\s]+)/i
      );

      if (urlMatch) {
        mediaUrl = urlMatch[1];
      }
    }

    /*
    |--------------------------------------------------------------------------
    | NÃO PUBLICA MENSAGEM VAZIA
    |--------------------------------------------------------------------------
    */

    if (!content && !mediaUrl) {
      await message.reply(
        "❌ Envie algum texto, arquivo ou link."
      );

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | SALVA NO BANCO
    |--------------------------------------------------------------------------
    */

    const postId = createPost({
      messageId: message.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorName: message.member?.displayName ||
        message.author.username,
      content,
      mediaUrl,
      mediaType
    });

    /*
    |--------------------------------------------------------------------------
    | BAIXA O ANEXO ORIGINAL PARA REENVIAR
    |--------------------------------------------------------------------------
    | A URL do anexo original fica atrelada à mensagem original. Se só
    | linkarmos essa URL e depois apagarmos a mensagem, o arquivo some
    | para todo mundo (menos para quem enviou, que já tinha em cache
    | local). Por isso baixamos o arquivo aqui e o reanexamos na própria
    | mensagem do feed, que nunca é apagada.
    */

    let attachmentBuilder = null;
    let attachmentFilename = null;

    if (sourceAttachment) {
      try {
        const response = await fetch(sourceAttachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        attachmentFilename =
          sourceAttachment.name || `arquivo_${Date.now()}`;

        attachmentBuilder = new AttachmentBuilder(buffer, {
          name: attachmentFilename
        });

        // Aponta o container para o arquivo que estamos anexando NESTA
        // mensagem, em vez da URL (prestes a expirar) da mensagem original.
        updatePostMedia(postId, `attachment://${attachmentFilename}`);
      } catch (error) {
        console.error(
          "⚠️ Não consegui baixar o anexo original para reenviar:",
          error
        );
        attachmentBuilder = null;
      }
    }

    /*
    |--------------------------------------------------------------------------
    | PUBLICA O POST PRIMEIRO
    |--------------------------------------------------------------------------
    */

    let sentMessage;

    try {
      sentMessage = await message.channel.send({
        components: [createPostContainer(postId)],
        files: attachmentBuilder ? [attachmentBuilder] : [],
        flags: MessageFlags.IsComponentsV2
      });

      console.log(
        `✅ Post publicado! ID: ${sentMessage.id}`
      );

    } catch (error) {

      console.error(
        "❌ ERRO AO PUBLICAR O POST:"
      );

      console.error(error);

      // NÃO apaga a mensagem original
      // se o envio falhar.

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | ATUALIZA A URL DA MÍDIA PARA A VERSÃO PERSISTENTE
    |--------------------------------------------------------------------------
    | Agora que o arquivo está anexado à mensagem do feed (que nunca é
    | apagada), guardamos essa URL definitiva no banco e re-renderizamos
    | com ela, trocando o "attachment://" temporário pela URL real do CDN.
    */

    if (sourceAttachment && sentMessage.attachments.size > 0) {
      const persistedAttachment = sentMessage.attachments.first();

      updatePostMedia(postId, persistedAttachment.url);

      await sentMessage.edit({
        components: [createPostContainer(postId)],
        flags: MessageFlags.IsComponentsV2
      }).catch(() => {});
    }

    /*
    |--------------------------------------------------------------------------
    | SÓ APAGA A MENSAGEM ORIGINAL DEPOIS
    |--------------------------------------------------------------------------
    */

    try {

      await message.delete();

      console.log(
        `🗑️ Mensagem original ${message.id} apagada.`
      );

    } catch (error) {

      console.error(
        "⚠️ Não consegui apagar a mensagem original:"
      );

      console.error(error);
    }

  } catch (error) {
    console.error("Erro ao processar mensagem:", error);
  }
});

/*
|--------------------------------------------------------------------------
| CONTAINER (COMPONENTS V2)
|--------------------------------------------------------------------------
| Um container único, com barra de cor lateral (setAccentColor), que
| agrupa texto (menção + legenda + curtidas/comentários), a mídia
| (imagem, vídeo ou arquivo) e os botões — tudo dentro da mesma caixa,
| sem a quebra visual que um embed clássico insere antes de um anexo cru.
*/

function createPostContainer(postId) {
  const post = getPost(postId);

  const container = new ContainerBuilder().setAccentColor(COLOR);

  if (!post) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("Post não encontrado.")
    );

    return container;
  }

  const likeCount = getLikeCount(postId);
  const commentCount = getCommentCount(postId);

  const caption = post.content ? `\n${post.content}` : "";
  const timestampSeconds = Math.floor(post.created_at / 1000);

  const text =
    `<@${post.author_id}>${caption}\n\n` +
    `❤️ ${likeCount} curtida(s)   •   💬 ${commentCount} comentário(s)`;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(text)
  );

  if (post.media_url) {
    const isImage = isImageMedia(post.media_type, post.media_url);
    const isVideo = isVideoMedia(post.media_type, post.media_url);

    if (isImage || isVideo) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(post.media_url)
        )
      );
    } else if (isUploadedFile(post.media_url)) {
      // Outro tipo de arquivo reenviado pelo bot (pdf, zip etc.) —
      // mostra como componente de arquivo, com download nativo do Discord.
      container.addFileComponents(
        new FileBuilder().setURL(post.media_url)
      );
    } else {
      // Foi um link externo colado no texto, não um arquivo enviado.
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🔗 ${post.media_url}`)
      );
    }
  }

  container.addActionRowComponents(createButtons(postId));

  return container;
}

/*
|--------------------------------------------------------------------------
| BOTÕES
|--------------------------------------------------------------------------
*/

function createButtons(postId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`like:${postId}`)
      .setLabel("Curtir")
      .setEmoji(EMOJI_LIKE_ID)
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`comment:${postId}`)
      .setLabel("Comentar")
      .setEmoji(EMOJI_COMMENT_ID)
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`comments:${postId}`)
      .setEmoji(EMOJI_VIEW_COMMENTS_ID)
      .setStyle(ButtonStyle.Secondary)
  );
}

/*
|--------------------------------------------------------------------------
| INTERAÇÕES
|--------------------------------------------------------------------------
*/

client.on("interactionCreate", async (interaction) => {
  try {

    /*
    |--------------------------------------------------------------------------
    | BOTÃO DE CURTIR
    |--------------------------------------------------------------------------
    */

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("like:")
    ) {
      const postId = Number(
        interaction.customId.split(":")[1]
      );

      const post = getPost(postId);

      if (!post) {
        await interaction.reply({
          content: "Esse post não existe mais.",
          ephemeral: true
        });

        return;
      }

      const liked = toggleLike(
        postId,
        interaction.user.id
      );

      await interaction.message.edit({
        components: [createPostContainer(postId)],
        flags: MessageFlags.IsComponentsV2
      });

      await interaction.reply({
        content: liked
          ? "❤️ Você curtiu esse post!"
          : "💔 Você removeu sua curtida.",
        ephemeral: true
      });

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | ABRIR MODAL DE COMENTÁRIO
    |--------------------------------------------------------------------------
    */

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("comment:")
    ) {
      const postId = Number(
        interaction.customId.split(":")[1]
      );

      const modal = new ModalBuilder()
        .setCustomId(`comment-modal:${postId}`)
        .setTitle("Comentar");

      const input = new TextInputBuilder()
        .setCustomId("comment")
        .setLabel("Seu comentário")
        .setPlaceholder("Escreva algo...")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(input)
      );

      await interaction.showModal(modal);

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | VER COMENTÁRIOS
    |--------------------------------------------------------------------------
    */

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("comments:")
    ) {
      const postId = Number(
        interaction.customId.split(":")[1]
      );

      const comments = getComments(postId);

      if (comments.length === 0) {
        await interaction.reply({
          content: "💬 Ainda não existem comentários.",
          ephemeral: true
        });

        return;
      }

      const text = comments
        .slice(-15)
        .map((comment) => {
          const safeContent = comment.content
            .replace(/@everyone/gi, "@ everyone")
            .replace(/@here/gi, "@ here");

          return `**${comment.user_name}**: ${safeContent}`;
        })
        .join("\n");

      await interaction.reply({
        content: `💬 **Comentários**\n\n${text}`,
        ephemeral: true
      });

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | ENVIO DO COMENTÁRIO
    |--------------------------------------------------------------------------
    */

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("comment-modal:")
    ) {
      const postId = Number(
        interaction.customId.split(":")[1]
      );

      const comment =
        interaction.fields.getTextInputValue("comment");

      const cleanComment = comment
        .replace(/@everyone/gi, "@ everyone")
        .replace(/@here/gi, "@ here")
        .trim();

      if (!cleanComment) {
        await interaction.reply({
          content: "O comentário está vazio.",
          ephemeral: true
        });

        return;
      }

      addComment(
        postId,
        interaction.user.id,
        interaction.member?.displayName ||
          interaction.user.username,
        cleanComment
      );

      /*
      |--------------------------------------------------------------------------
      | ATUALIZA O POST
      |--------------------------------------------------------------------------
      */

      const message = interaction.message;

      if (message) {
        await message.edit({
          components: [createPostContainer(postId)],
          flags: MessageFlags.IsComponentsV2
        }).catch(() => {});
      }

      await interaction.reply({
        content: "💬 Comentário publicado!",
        ephemeral: true
      });

      return;
    }

  } catch (error) {
    console.error(
      "Erro na interação:",
      error
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Ocorreu um erro.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

if (!process.env.DISCORD_TOKEN) {
  console.error(
    "❌ DISCORD_TOKEN não encontrado no arquivo .env"
  );

  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN)
  .then(() => {
    console.log("🔑 Token aceito pelo Discord.");
  })
  .catch((error) => {
    console.error("❌ Não foi possível conectar ao Discord:");
    console.error(error);
  });

client.on("error", (error) => {
  console.error("❌ Erro do cliente Discord:");
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promise rejeitada:");
  console.error(error);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Exceção não tratada:");
  console.error(error);
});