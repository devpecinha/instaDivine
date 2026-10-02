const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(
  path.join(__dirname, "..", "feed.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT,
    media_url TEXT,
    media_type TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

function createPost(data) {
  const stmt = db.prepare(`
    INSERT INTO posts (
      message_id,
      channel_id,
      author_id,
      author_name,
      content,
      media_url,
      media_type,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.messageId,
    data.channelId,
    data.authorId,
    data.authorName,
    data.content || "",
    data.mediaUrl || null,
    data.mediaType || null,
    Date.now()
  );

  return result.lastInsertRowid;
}

function getPost(id) {
  return db.prepare(`
    SELECT *
    FROM posts
    WHERE id = ?
  `).get(id);
}

function getPostByMessage(messageId) {
  return db.prepare(`
    SELECT *
    FROM posts
    WHERE message_id = ?
  `).get(messageId);
}

function hasLiked(postId, userId) {
  return !!db.prepare(`
    SELECT 1
    FROM likes
    WHERE post_id = ? AND user_id = ?
  `).get(postId, userId);
}

function toggleLike(postId, userId) {
  if (hasLiked(postId, userId)) {
    db.prepare(`
      DELETE FROM likes
      WHERE post_id = ? AND user_id = ?
    `).run(postId, userId);

    return false;
  }

  db.prepare(`
    INSERT INTO likes (post_id, user_id)
    VALUES (?, ?)
  `).run(postId, userId);

  return true;
}

function getLikeCount(postId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM likes
    WHERE post_id = ?
  `).get(postId).count;
}

function addComment(postId, userId, userName, content) {
  db.prepare(`
    INSERT INTO comments (
      post_id,
      user_id,
      user_name,
      content,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    postId,
    userId,
    userName,
    content,
    Date.now()
  );
}

function getComments(postId) {
  return db.prepare(`
    SELECT *
    FROM comments
    WHERE post_id = ?
    ORDER BY created_at ASC
  `).all(postId);
}

function updatePostMedia(postId, mediaUrl) {
  db.prepare(`
    UPDATE posts
    SET media_url = ?
    WHERE id = ?
  `).run(mediaUrl, postId);
}

function getCommentCount(postId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM comments
    WHERE post_id = ?
  `).get(postId).count;
}

module.exports = {
  createPost,
  getPost,
  getPostByMessage,
  hasLiked,
  toggleLike,
  getLikeCount,
  addComment,
  getComments,
  getCommentCount,
  updatePostMedia
};
