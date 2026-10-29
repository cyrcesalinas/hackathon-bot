-- Unified Oracle setup for the Discord agent store.
--
-- Run this file as AGENT_STORE_OWNER with SQLcl, SQL*Plus, or a compatible
-- Oracle client. It is safe to retry:
--   * An empty schema receives the complete AGENT_PROFILES table.
--   * A legacy agent table is upgraded in place without deleting agent rows.
--   * An up-to-date schema is left unchanged.
--
-- Agent names are globally unique, case-insensitively. If an older table has
-- duplicate names owned by different users, this script stops before changing
-- the name indexes. Rename those duplicates and rerun the script.
--
-- This script intentionally does not create database users or contain
-- credentials. Grant the runtime user SELECT, INSERT, UPDATE, and DELETE on
-- AGENT_PROFILES after setup when the runtime user differs from the owner.
-- Back up AGENT_PROFILES before upgrading an existing production table.

SET SERVEROUTPUT ON

DECLARE
  v_count PLS_INTEGER;

  FUNCTION table_exists(p_table_name IN VARCHAR2) RETURN BOOLEAN IS
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM USER_TABLES
     WHERE TABLE_NAME = UPPER(p_table_name);
    RETURN v_count > 0;
  END table_exists;

  FUNCTION column_exists(
    p_table_name  IN VARCHAR2,
    p_column_name IN VARCHAR2
  ) RETURN BOOLEAN IS
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM USER_TAB_COLUMNS
     WHERE TABLE_NAME = UPPER(p_table_name)
       AND COLUMN_NAME = UPPER(p_column_name);
    RETURN v_count > 0;
  END column_exists;

  FUNCTION constraint_exists(p_constraint_name IN VARCHAR2) RETURN BOOLEAN IS
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM USER_CONSTRAINTS
     WHERE CONSTRAINT_NAME = UPPER(p_constraint_name);
    RETURN v_count > 0;
  END constraint_exists;

  FUNCTION capability_constraint_is_current RETURN BOOLEAN IS
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM USER_CONSTRAINTS
     WHERE CONSTRAINT_NAME = 'AGENT_PROFILES_CAPABILITY_CK'
       AND UPPER(SEARCH_CONDITION_VC) LIKE '%''CUSTOM''%';
    RETURN v_count > 0;
  END capability_constraint_is_current;

  FUNCTION index_exists(p_index_name IN VARCHAR2) RETURN BOOLEAN IS
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM USER_INDEXES
     WHERE INDEX_NAME = UPPER(p_index_name);
    RETURN v_count > 0;
  END index_exists;
BEGIN
  IF NOT table_exists('AGENT_PROFILES') THEN
    EXECUTE IMMEDIATE q'~
      CREATE TABLE AGENT_PROFILES (
        AGENT_ID VARCHAR2(36 CHAR) NOT NULL,
        OWNER_USER_ID VARCHAR2(32 CHAR) NOT NULL,
        NAME VARCHAR2(32 CHAR) NOT NULL,
        GOAL VARCHAR2(1000 CHAR) NOT NULL,
        STYLE VARCHAR2(300 CHAR) NOT NULL,
        CAPABILITY VARCHAR2(16 CHAR) NOT NULL,
        PRESET VARCHAR2(32 CHAR) DEFAULT 'custom' NOT NULL,
        TOOLS_JSON VARCHAR2(500 CHAR) DEFAULT '[]' NOT NULL,
        RESPONSE_FORMAT VARCHAR2(32 CHAR) DEFAULT 'balanced' NOT NULL,
        LANGUAGE VARCHAR2(8 CHAR) DEFAULT 'auto' NOT NULL,
        VERSION_NO NUMBER(10) DEFAULT 1 NOT NULL,
        CREATED_AT TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
        UPDATED_AT TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT AGENT_PROFILES_PK PRIMARY KEY (AGENT_ID),
        CONSTRAINT AGENT_PROFILES_CAPABILITY_CK
          CHECK (CAPABILITY IN ('chat', 'study', 'research', 'custom')),
        CONSTRAINT AGENT_PROFILES_TOOLS_JSON_CK CHECK (TOOLS_JSON IS JSON),
        CONSTRAINT AGENT_PROFILES_RESPONSE_CK
          CHECK (RESPONSE_FORMAT IN (
            'balanced', 'concise', 'detailed', 'step_by_step', 'structured', 'report'
          )),
        CONSTRAINT AGENT_PROFILES_LANGUAGE_CK
          CHECK (LANGUAGE IN ('auto', 'en', 'es')),
        CONSTRAINT AGENT_PROFILES_VERSION_CK CHECK (VERSION_NO >= 1)
      )
    ~';
    DBMS_OUTPUT.PUT_LINE('Created AGENT_PROFILES.');
  ELSE
    DBMS_OUTPUT.PUT_LINE('AGENT_PROFILES exists; checking for upgrades.');

    IF NOT column_exists('AGENT_PROFILES', 'PRESET') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD (
          PRESET VARCHAR2(32 CHAR) DEFAULT 'custom' NOT NULL
        )
      ~';
      EXECUTE IMMEDIATE q'~
        UPDATE AGENT_PROFILES
           SET PRESET = CASE CAPABILITY
             WHEN 'research' THEN 'researcher'
             WHEN 'study' THEN 'study_coach'
             ELSE 'custom'
           END
      ~';
    END IF;

    IF NOT column_exists('AGENT_PROFILES', 'TOOLS_JSON') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD (
          TOOLS_JSON VARCHAR2(500 CHAR) DEFAULT '[]' NOT NULL
        )
      ~';
      EXECUTE IMMEDIATE q'~
        UPDATE AGENT_PROFILES
           SET TOOLS_JSON = CASE CAPABILITY
             WHEN 'research' THEN '["web_search"]'
             WHEN 'study' THEN '["file_analysis"]'
             ELSE '[]'
           END
      ~';
    END IF;

    IF NOT column_exists('AGENT_PROFILES', 'RESPONSE_FORMAT') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD (
          RESPONSE_FORMAT VARCHAR2(32 CHAR) DEFAULT 'balanced' NOT NULL
        )
      ~';
      EXECUTE IMMEDIATE q'~
        UPDATE AGENT_PROFILES
           SET RESPONSE_FORMAT = CASE CAPABILITY
             WHEN 'research' THEN 'report'
             WHEN 'study' THEN 'structured'
             ELSE 'balanced'
           END
      ~';
    END IF;

    IF NOT column_exists('AGENT_PROFILES', 'LANGUAGE') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD (
          LANGUAGE VARCHAR2(8 CHAR) DEFAULT 'auto' NOT NULL
        )
      ~';
    END IF;

    IF NOT column_exists('AGENT_PROFILES', 'VERSION_NO') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD (
          VERSION_NO NUMBER(10) DEFAULT 1 NOT NULL
        )
      ~';
    END IF;

    -- The original constraint did not allow the v2 'custom' capability.
    IF constraint_exists('AGENT_PROFILES_CAPABILITY_CK')
       AND NOT capability_constraint_is_current THEN
      EXECUTE IMMEDIATE
        'ALTER TABLE AGENT_PROFILES DROP CONSTRAINT AGENT_PROFILES_CAPABILITY_CK';
    END IF;

    IF NOT constraint_exists('AGENT_PROFILES_CAPABILITY_CK') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD CONSTRAINT AGENT_PROFILES_CAPABILITY_CK
          CHECK (CAPABILITY IN ('chat', 'study', 'research', 'custom'))
      ~';
    END IF;

    IF NOT constraint_exists('AGENT_PROFILES_TOOLS_JSON_CK') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD CONSTRAINT AGENT_PROFILES_TOOLS_JSON_CK
          CHECK (TOOLS_JSON IS JSON)
      ~';
    END IF;

    IF NOT constraint_exists('AGENT_PROFILES_RESPONSE_CK') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD CONSTRAINT AGENT_PROFILES_RESPONSE_CK
          CHECK (RESPONSE_FORMAT IN (
            'balanced', 'concise', 'detailed', 'step_by_step', 'structured', 'report'
          ))
      ~';
    END IF;

    IF NOT constraint_exists('AGENT_PROFILES_LANGUAGE_CK') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD CONSTRAINT AGENT_PROFILES_LANGUAGE_CK
          CHECK (LANGUAGE IN ('auto', 'en', 'es'))
      ~';
    END IF;

    IF NOT constraint_exists('AGENT_PROFILES_VERSION_CK') THEN
      EXECUTE IMMEDIATE q'~
        ALTER TABLE AGENT_PROFILES ADD CONSTRAINT AGENT_PROFILES_VERSION_CK
          CHECK (VERSION_NO >= 1)
      ~';
    END IF;
  END IF;

  -- Keep this query dynamic so a fresh schema can compile this block before
  -- AGENT_PROFILES is created earlier in the same block.
  EXECUTE IMMEDIATE q'~
    SELECT COUNT(*)
      FROM (
        SELECT UPPER(NAME)
          FROM AGENT_PROFILES
         GROUP BY UPPER(NAME)
        HAVING COUNT(*) > 1
      )
  ~' INTO v_count;

  IF v_count > 0 THEN
    RAISE_APPLICATION_ERROR(
      -20001,
      'Duplicate agent names exist. Agent names must be globally unique; rename duplicates and rerun this script.'
    );
  END IF;

  IF NOT index_exists('AGENT_PROFILES_NAME_UQ') THEN
    EXECUTE IMMEDIATE q'~
      CREATE UNIQUE INDEX AGENT_PROFILES_NAME_UQ
        ON AGENT_PROFILES (UPPER(NAME))
    ~';
  END IF;

  IF index_exists('AGENT_PROFILES_OWNER_NAME_UQ') THEN
    EXECUTE IMMEDIATE 'DROP INDEX AGENT_PROFILES_OWNER_NAME_UQ';
  END IF;

  IF index_exists('AGENT_PROFILES_GUILD_NAME_UQ') THEN
    EXECUTE IMMEDIATE 'DROP INDEX AGENT_PROFILES_GUILD_NAME_UQ';
  END IF;

  DBMS_OUTPUT.PUT_LINE('Agent store schema is ready in ' || USER || '.');
END;
/

COMMIT;

-- Optional when AGENT_STORE_USER is different from AGENT_STORE_OWNER:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON AGENT_PROFILES TO BOT_AGENT_APP;
