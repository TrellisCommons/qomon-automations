-- Counts restore_checks.py runs. Format: -- name [| expected]. Expected values go only in the copy kept inside each archive.
-- contacts
SELECT
    COUNT(DISTINCT id)
FROM
    contacts;

-- contact_history_contacts
SELECT
    COUNT(*)
FROM
    contact_history_raw;

-- notes
SELECT
    COUNT(*)
FROM
    notes;

-- notes_contacts
SELECT
    COUNT(DISTINCT contact_id)
FROM
    notes;

-- survey_answers
SELECT
    COUNT(*)
FROM
    survey_answers;

-- survey_dangling_form
SELECT
    COUNT(*)
FROM
    survey_answers
WHERE
    dangling_form = 1;

-- survey_dangling_ref
SELECT
    COUNT(*)
FROM
    survey_answers
WHERE
    dangling_ref = 1;

-- contact_tags
SELECT
    COUNT(*)
FROM
    contact_tags;

-- contact_custom_fields
SELECT
    COUNT(*)
FROM
    contact_custom_fields;

-- email_campaign_details
SELECT
    COUNT(*)
FROM
    email_campaigns;

-- sms_delivered
SELECT
    COUNT(*)
FROM
    history_sms
WHERE
    status = 'delivered';

-- sms_sent
SELECT
    COUNT(*)
FROM
    history_sms
WHERE
    status = 'sent';

-- sms_error
SELECT
    COUNT(*)
FROM
    history_sms
WHERE
    status = 'error';

-- action_details
SELECT
    COUNT(*)
FROM
    action_details;

-- participation_events
SELECT
    COUNT(*)
FROM
    history_participation;

-- participation_dangling
SELECT
    COUNT(*)
FROM
    history_participation
WHERE
    dangling_action = 1;

-- online_form_links
SELECT
    COUNT(*)
FROM
    segment_contacts
WHERE
    segment_id IN (
        SELECT
            id
        FROM
            segments
        WHERE
            kind = 'online_form'
    );

-- online_form_events
SELECT
    COUNT(*)
FROM
    history_online_form;

-- segment_contacts_dangling
SELECT
    COUNT(*)
FROM
    segment_contacts
WHERE
    dangling = 1;

-- donations
SELECT
    COUNT(*)
FROM
    donations;

-- transactions
SELECT
    COUNT(*)
FROM
    transactions;

-- donation_total_cents
SELECT
    SUM(amount)
FROM
    donations;

-- transaction_total_cents
SELECT
    SUM(amount)
FROM
    transactions;

-- bundles
SELECT
    COUNT(*)
FROM
    transaction_bundles;

-- users
SELECT
    COUNT(*)
FROM
    users;

-- teams
SELECT
    COUNT(*)
FROM
    teams_with_users;

-- documents
SELECT
    COUNT(*)
FROM
    documents;

-- assets
SELECT
    COUNT(*)
FROM
    assets;

-- metabase_files
SELECT
    COUNT(*)
FROM
    load_coverage
WHERE
    file LIKE 'metabase/%';

-- bulk_updates_loaded
SELECT
    COUNT(*)
FROM
    load_coverage
WHERE
    file = 'reference/bulk_updates.json';

-- imports_loaded
SELECT
    COUNT(*)
FROM
    load_coverage
WHERE
    file = 'reference/imports.json';

-- history_import
SELECT
    COUNT(*)
FROM
    history_import;

-- history_fact
SELECT
    COUNT(*)
FROM
    history_fact;

-- history_formdatas
SELECT
    COUNT(*)
FROM
    history_formdatas;

-- history_email
SELECT
    COUNT(*)
FROM
    history_email;

-- history_customfield
SELECT
    COUNT(*)
FROM
    history_customfield;

-- history_sms
SELECT
    COUNT(*)
FROM
    history_sms;

-- history_interaction
SELECT
    COUNT(*)
FROM
    history_interaction;

-- history_note
SELECT
    COUNT(*)
FROM
    history_note;
