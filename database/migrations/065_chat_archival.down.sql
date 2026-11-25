-- Down migration for 065_chat_archival
DROP TABLE IF EXISTS chat_archival_summaries;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
