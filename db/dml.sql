-- Load the six public workshop examples into the current schema's
-- AGENT_PROFILES table. Run as the table owner with Database Actions
-- SQL Worksheet > Run Script. This script can be rerun safely.
--
-- The fixed IDs and names are reserved for this seed. Existing matching rows
-- are validated and left untouched; conflicts stop the load before inserts.

SET SERVEROUTPUT ON

SAVEPOINT workshop_agent_seed;

DECLARE
  v_seeded_at TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;

  FUNCTION profile_exists(p_agent_id IN VARCHAR2) RETURN BOOLEAN IS
    v_count PLS_INTEGER;
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM AGENT_PROFILES
     WHERE AGENT_ID = p_agent_id;
    RETURN v_count > 0;
  END profile_exists;

  PROCEDURE validate_profile(
    p_agent_id         IN VARCHAR2,
    p_owner_user_id    IN VARCHAR2,
    p_name             IN VARCHAR2,
    p_goal             IN VARCHAR2,
    p_style            IN VARCHAR2,
    p_capability       IN VARCHAR2,
    p_preset           IN VARCHAR2,
    p_tools_json       IN VARCHAR2,
    p_response_format  IN VARCHAR2,
    p_language         IN VARCHAR2,
    p_version_no       IN NUMBER
  ) IS
    v_count              PLS_INTEGER;
    v_owner_user_id      AGENT_PROFILES.OWNER_USER_ID%TYPE;
    v_name               AGENT_PROFILES.NAME%TYPE;
    v_goal               AGENT_PROFILES.GOAL%TYPE;
    v_style              AGENT_PROFILES.STYLE%TYPE;
    v_capability         AGENT_PROFILES.CAPABILITY%TYPE;
    v_preset             AGENT_PROFILES.PRESET%TYPE;
    v_tools_json         AGENT_PROFILES.TOOLS_JSON%TYPE;
    v_response_format    AGENT_PROFILES.RESPONSE_FORMAT%TYPE;
    v_language           AGENT_PROFILES.LANGUAGE%TYPE;
    v_version_no         AGENT_PROFILES.VERSION_NO%TYPE;
    v_created_at         AGENT_PROFILES.CREATED_AT%TYPE;
    v_updated_at         AGENT_PROFILES.UPDATED_AT%TYPE;
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM AGENT_PROFILES
     WHERE UPPER(NAME) = UPPER(p_name)
       AND AGENT_ID <> p_agent_id;

    IF v_count > 0 THEN
      RAISE_APPLICATION_ERROR(
        -20001,
        'Reserved workshop name conflicts with another row: ' || p_name
      );
    END IF;

    SELECT COUNT(*)
      INTO v_count
      FROM AGENT_PROFILES
     WHERE AGENT_ID = p_agent_id;

    IF v_count = 0 THEN
      RETURN;
    END IF;

    SELECT OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
           TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO,
           CREATED_AT, UPDATED_AT
      INTO v_owner_user_id, v_name, v_goal, v_style, v_capability, v_preset,
           v_tools_json, v_response_format, v_language, v_version_no,
           v_created_at, v_updated_at
      FROM AGENT_PROFILES
     WHERE AGENT_ID = p_agent_id;

    IF v_owner_user_id <> p_owner_user_id
       OR v_name <> p_name
       OR v_goal <> p_goal
       OR v_style <> p_style
       OR v_capability <> p_capability
       OR v_preset <> p_preset
       OR v_tools_json <> p_tools_json
       OR v_response_format <> p_response_format
       OR v_language <> p_language
       OR v_version_no <> p_version_no
       OR v_created_at IS NULL
       OR v_updated_at IS NULL THEN
      RAISE_APPLICATION_ERROR(
        -20002,
        'Reserved workshop ID has a different owner or configuration: ' || p_name
      );
    END IF;
  END validate_profile;
BEGIN
  -- Validate every reserved ID and name before adding any missing profiles.
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000001', 'WORKSHOP_DEMO',
    'demo-sql-tutor', 'Teach how to build SQL queries.',
    'Explain each step and end with a sample query.',
    'study', 'tutor', '["file_analysis"]', 'step_by_step', 'en', 1
  );
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000002', 'WORKSHOP_DEMO',
    'demo-oci-guide', 'Guide the student through OCI concepts.',
    'Define each concept in plain language and give an example of its use.',
    'chat', 'general', '[]', 'balanced', 'en', 1
  );
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000003', 'WORKSHOP_DEMO',
    'demo-data-researcher', 'Research database topics.',
    'Summarize findings and cite the sources consulted.',
    'research', 'researcher', '["web_search"]', 'report', 'en', 1
  );
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000004', 'WORKSHOP_DEMO',
    'demo-study-coach', 'Help the student review the study material.',
    'Break the topic into short exercises and provide feedback.',
    'study', 'study_coach', '["file_analysis"]', 'structured', 'en', 1
  );
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000005', 'WORKSHOP_DEMO',
    'demo-cloud-research', 'Research cloud services.',
    'Compare options using explicit criteria and cite the sources.',
    'research', 'researcher', '["web_search"]', 'report', 'en', 1
  );
  validate_profile(
    '5f3a2c10-9b81-4d67-a2e5-001000000006', 'WORKSHOP_DEMO',
    'demo-help-desk', 'Answer general workshop questions.',
    'Respond briefly and indicate the next step when appropriate.',
    'chat', 'general', '[]', 'balanced', 'en', 1
  );

  DBMS_OUTPUT.PUT_LINE('All existing workshop examples match; adding agents.');

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000001') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-sql-tutor.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000001', 'WORKSHOP_DEMO',
      'demo-sql-tutor', 'Teach how to build SQL queries.',
      'Explain each step and end with a sample query.',
      'study', 'tutor', '["file_analysis"]', 'step_by_step', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000002') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-oci-guide.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000002', 'WORKSHOP_DEMO',
      'demo-oci-guide', 'Guide the student through OCI concepts.',
      'Define each concept in plain language and give an example of its use.',
      'chat', 'general', '[]', 'balanced', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000003') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-data-researcher.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000003', 'WORKSHOP_DEMO',
      'demo-data-researcher', 'Research database topics.',
      'Summarize findings and cite the sources consulted.',
      'research', 'researcher', '["web_search"]', 'report', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000004') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-study-coach.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000004', 'WORKSHOP_DEMO',
      'demo-study-coach', 'Help the student review the study material.',
      'Break the topic into short exercises and provide feedback.',
      'study', 'study_coach', '["file_analysis"]', 'structured', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000005') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-cloud-research.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000005', 'WORKSHOP_DEMO',
      'demo-cloud-research', 'Research cloud services.',
      'Compare options using explicit criteria and cite the sources.',
      'research', 'researcher', '["web_search"]', 'report', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  IF NOT profile_exists('5f3a2c10-9b81-4d67-a2e5-001000000006') THEN
    DBMS_OUTPUT.PUT_LINE('Inserting demo-help-desk.');
    INSERT INTO AGENT_PROFILES (
      AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, PRESET,
      TOOLS_JSON, RESPONSE_FORMAT, LANGUAGE, VERSION_NO, CREATED_AT, UPDATED_AT
    ) VALUES (
      '5f3a2c10-9b81-4d67-a2e5-001000000006', 'WORKSHOP_DEMO',
      'demo-help-desk', 'Answer general workshop questions.',
      'Respond briefly and indicate the next step when appropriate.',
      'chat', 'general', '[]', 'balanced', 'en', 1,
      v_seeded_at, v_seeded_at
    );
  END IF;

  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Workshop agents are loaded and committed.');
EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK TO workshop_agent_seed;
    DBMS_OUTPUT.PUT_LINE('Workshop agent load rolled back: ' || SQLERRM);
    RAISE;
END;
/
