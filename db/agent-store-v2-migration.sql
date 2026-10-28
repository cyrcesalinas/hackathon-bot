-- Run once as AGENT_STORE_OWNER when upgrading an existing AGENT_PROFILES table.
-- Back up the table before applying the migration.

ALTER TABLE AGENT_PROFILES ADD (
  PRESET VARCHAR2(32 CHAR) DEFAULT 'custom' NOT NULL,
  TOOLS_JSON VARCHAR2(500 CHAR) DEFAULT '[]' NOT NULL,
  RESPONSE_FORMAT VARCHAR2(32 CHAR) DEFAULT 'balanced' NOT NULL,
  LANGUAGE VARCHAR2(8 CHAR) DEFAULT 'auto' NOT NULL,
  VERSION_NO NUMBER(10) DEFAULT 1 NOT NULL
);

UPDATE AGENT_PROFILES
   SET PRESET = CASE CAPABILITY
     WHEN 'research' THEN 'researcher'
     WHEN 'study' THEN 'study_coach'
     ELSE 'custom'
   END,
       TOOLS_JSON = CASE CAPABILITY
         WHEN 'research' THEN '["web_search"]'
         WHEN 'study' THEN '["file_analysis"]'
         ELSE '[]'
       END,
       RESPONSE_FORMAT = CASE CAPABILITY
         WHEN 'research' THEN 'report'
         WHEN 'study' THEN 'structured'
         ELSE 'balanced'
       END;

ALTER TABLE AGENT_PROFILES DROP CONSTRAINT AGENT_PROFILES_CAPABILITY_CK;

ALTER TABLE AGENT_PROFILES ADD (
  CONSTRAINT AGENT_PROFILES_CAPABILITY_CK CHECK (CAPABILITY IN ('chat', 'study', 'research', 'custom')),
  CONSTRAINT AGENT_PROFILES_TOOLS_JSON_CK CHECK (TOOLS_JSON IS JSON),
  CONSTRAINT AGENT_PROFILES_RESPONSE_CK CHECK (
    RESPONSE_FORMAT IN ('balanced', 'concise', 'detailed', 'step_by_step', 'structured', 'report')
  ),
  CONSTRAINT AGENT_PROFILES_LANGUAGE_CK CHECK (LANGUAGE IN ('auto', 'en', 'es')),
  CONSTRAINT AGENT_PROFILES_VERSION_CK CHECK (VERSION_NO >= 1)
);

COMMIT;
