const { query } = require('./database');

async function runMigrations() {
  console.log('[migrate] Iniciando migracoes automaticas...');
  try {
    // ─── receptionists ────────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS receptionists (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        name          text        NOT NULL,
        email         text        NOT NULL UNIQUE,
        password_hash text        NOT NULL,
        active        boolean     NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── doctor_certificates ─────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS doctor_certificates (
        id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id               uuid        NOT NULL UNIQUE REFERENCES doctors(id) ON DELETE CASCADE,
        provider_type           text        NOT NULL,
        status                  text        NOT NULL DEFAULT 'DISCONNECTED'
                                CHECK (status IN ('DISCONNECTED','CONNECTED','EXPIRED','ERROR')),
        provider_subject        text,
        provider_account_id     text,
        access_token_encrypted  text,
        refresh_token_encrypted text,
        token_expires_at        timestamptz,
        scopes                  text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── Google Calendar columns ──────────────────────────────────
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS google_refresh_token     text`);
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS google_calendar_connected boolean NOT NULL DEFAULT false`);
    await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS google_event_id    text`);

    // ─── patients extras ─────────────────────────────────────────
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS password_hash       text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS address             text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS reference_face_path text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact_name  text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact_phone text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS medical_history         text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS lgpd_consent_version    text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS lgpd_consent_at         timestamptz`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS google_refresh_token text`);
    await query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS google_calendar_connected boolean NOT NULL DEFAULT false`);

    // ─── surgeries extras ────────────────────────────────────────
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS procedure_type      text`);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS procedure_details   text`);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS complications       text`);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS procedure_classification text`);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS require_qualified_signature boolean NOT NULL DEFAULT false`);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS notes               text`);

    // ─── medical_records (prontuários) ──────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS medical_records (
        id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id           uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        doctor_id            uuid        REFERENCES doctors(id) ON DELETE SET NULL,
        title                text        NOT NULL,
        summary              text,
        clinical_history     text,
        allergies            text,
        chronic_conditions   text,
        current_medications  text,
        status               text        NOT NULL DEFAULT 'OPEN'
                          CHECK (status in ('OPEN', 'COMPLETED')),
        closed_at            timestamptz,
        lgpd_consent_version text,
        lgpd_consent_at      timestamptz,
        active               boolean     NOT NULL DEFAULT true,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'OPEN'`);
    await query(`ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
    await query(`ALTER TABLE medical_records DROP CONSTRAINT IF EXISTS medical_records_status_check`);
    await query(`ALTER TABLE medical_records ADD CONSTRAINT medical_records_status_check CHECK (status in ('OPEN', 'COMPLETED'))`);
    await query(`CREATE INDEX IF NOT EXISTS idx_medical_records_patient ON medical_records(patient_id, updated_at DESC)`);

    await query(`
      CREATE TABLE IF NOT EXISTS patient_clinical_followups (
        id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id               uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        doctor_id                uuid        NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
        medical_record_id        uuid        REFERENCES medical_records(id) ON DELETE SET NULL,
        chief_complaint          text,
        complaint_duration       text,
        history_present_illness  text,
        systems_review           jsonb       NOT NULL DEFAULT '{}'::jsonb,
        personal_history         jsonb       NOT NULL DEFAULT '{}'::jsonb,
        family_history           jsonb       NOT NULL DEFAULT '{}'::jsonb,
        srq20_answers            jsonb       NOT NULL DEFAULT '{}'::jsonb,
        physical_exam_general    text,
        physical_exam_special    text,
        surgical_risk            text,
        diagnosis_hypothesis     text,
        therapeutic_plan         text,
        evolution_notes          text,
        photo_documentation      jsonb       NOT NULL DEFAULT '{}'::jsonb,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_clinical_followups_patient ON patient_clinical_followups(patient_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_clinical_followups_record ON patient_clinical_followups(medical_record_id, created_at DESC)`);
    await query(`ALTER TABLE patient_clinical_followups ADD COLUMN IF NOT EXISTS surgery_id uuid`);
    await query(`CREATE INDEX IF NOT EXISTS idx_clinical_followups_surgery ON patient_clinical_followups(surgery_id, created_at DESC)`);
    await query(`ALTER TABLE patient_clinical_followups DROP CONSTRAINT IF EXISTS patient_clinical_followups_surgery_fk`);
    await query(`
      ALTER TABLE patient_clinical_followups
      ADD CONSTRAINT patient_clinical_followups_surgery_fk
      FOREIGN KEY (surgery_id) REFERENCES surgeries(id) ON DELETE SET NULL
    `);
    await query(`ALTER TABLE surgeries ADD COLUMN IF NOT EXISTS medical_record_id uuid`);
    await query(`CREATE INDEX IF NOT EXISTS idx_surgeries_medical_record ON surgeries(medical_record_id)`);
    await query(`ALTER TABLE surgeries DROP CONSTRAINT IF EXISTS surgeries_medical_record_fk`);
    await query(`
      ALTER TABLE surgeries
      ADD CONSTRAINT surgeries_medical_record_fk
      FOREIGN KEY (medical_record_id) REFERENCES medical_records(id) ON DELETE SET NULL
    `);

    // ─── patient tablet intake sessions ─────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS patient_tablet_sessions (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        token             text        NOT NULL UNIQUE,
        patient_id        uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        consultation_id   uuid        REFERENCES consultations(id) ON DELETE SET NULL,
        receptionist_id   uuid        REFERENCES receptionists(id) ON DELETE SET NULL,
        clinic_id         uuid,
        intake_mode       text        NOT NULL DEFAULT 'BLANK' CHECK (intake_mode IN ('BLANK', 'PREFILLED')),
        status            text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'VERIFIED', 'SUBMITTED', 'EXPIRED')),
        face_verified     boolean     NOT NULL DEFAULT false,
        face_similarity   numeric(5,2),
        face_capture_path text,
        intake_data_json  jsonb       NOT NULL DEFAULT '{}'::jsonb,
        expires_at        timestamptz  NOT NULL,
        verified_at       timestamptz,
        submitted_at      timestamptz,
        created_at        timestamptz  NOT NULL DEFAULT now(),
        updated_at        timestamptz  NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_tablet_sessions_patient ON patient_tablet_sessions(patient_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_tablet_sessions_status ON patient_tablet_sessions(status, expires_at)`);

    // ─── patient self-registration links ───────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS patient_registration_links (
        id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        token                text        NOT NULL UNIQUE,
        clinic_id            uuid,
        doctor_id            uuid        REFERENCES doctors(id) ON DELETE SET NULL,
        requested_email      text,
        status               text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'EXPIRED', 'CANCELLED')),
        expires_at           timestamptz NOT NULL,
        submitted_at         timestamptz,
        submitted_patient_id uuid        REFERENCES patients(id) ON DELETE SET NULL,
        payload_json         jsonb       NOT NULL DEFAULT '{}'::jsonb,
        sent_via_email       boolean     NOT NULL DEFAULT false,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_registration_links_status ON patient_registration_links(status, expires_at)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_registration_links_clinic ON patient_registration_links(clinic_id, created_at DESC)`);

    // ─── document_templates extras ───────────────────────────────
    await query(`ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS procedure_type text`);

    // ─── surgery_documents extras ────────────────────────────────
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS content_hash        text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS pdf_hash_generated  text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS pdf_hash_signed     text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS tsa_provider        text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS tsa_token           text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS tsa_timestamp_at    timestamptz`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS qualified_provider  text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS qualified_ref       text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS lgpd_policy_version text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS legal_terms_version text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS risk_ack_text       text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS signed_content_hash text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS signed_user_agent   text`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS total_pages         integer NOT NULL DEFAULT 1`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS pages_read          integer NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE surgery_documents ADD COLUMN IF NOT EXISTS read_completed_at   timestamptz`);

    // ─── doctor_certificates extras ──────────────────────────────
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS provider_subject        text`);
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS provider_account_id     text`);
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS access_token_encrypted  text`);
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS refresh_token_encrypted text`);
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS token_expires_at        timestamptz`);
    await query(`ALTER TABLE doctor_certificates ADD COLUMN IF NOT EXISTS scopes                  text`);

    // ─── signature_audit_logs ────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS signature_audit_logs (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id     uuid        NOT NULL REFERENCES surgery_documents(id) ON DELETE CASCADE,
        event_type      text        NOT NULL CHECK (event_type IN ('GENERATED','READ_PROGRESS','SIGNED')),
        ip_address      text,
        user_agent      text,
        prev_event_hash text,
        event_hash      text,
        payload_json    jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── procedure_types ─────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS procedure_types (
        id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id                 uuid        REFERENCES doctors(id) ON DELETE CASCADE,
        name                      text        NOT NULL,
        category                  text        NOT NULL DEFAULT 'CIRURGIA',
        description               text,
        default_risks             text,
        default_preparation       text,
        estimated_duration_min    integer,
        require_qualified_signature boolean   NOT NULL DEFAULT false,
        active                    boolean     NOT NULL DEFAULT true,
        created_at                timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`ALTER TABLE procedure_types DROP CONSTRAINT IF EXISTS procedure_types_category_check`);
    await query(`
      CREATE TABLE IF NOT EXISTS procedure_type_categories (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id   uuid REFERENCES doctors(id) ON DELETE CASCADE,
        name        text NOT NULL,
        active      boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_procedure_types_doctor ON procedure_types(doctor_id, active)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_procedure_type_categories_doctor ON procedure_type_categories(doctor_id, active)`);
    await query(`ALTER TABLE procedure_type_categories ADD COLUMN IF NOT EXISTS base_default text`);

    // ─── CID-10 customizados por médico ──────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS cid10_custom (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id   uuid        REFERENCES doctors(id) ON DELETE CASCADE,
        code        text        NOT NULL,
        description text        NOT NULL,
        category    text,
        active      boolean     NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (doctor_id, code)
      )
    `);

    // ─── Receitas médicas ─────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id     uuid        NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        patient_id    uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        surgery_id    uuid        REFERENCES surgeries(id) ON DELETE SET NULL,
        medical_record_id uuid    REFERENCES medical_records(id) ON DELETE SET NULL,
        medications   jsonb       NOT NULL DEFAULT '[]',
        notes         text,
        valid_days    integer     NOT NULL DEFAULT 30,
        issued_at     date        NOT NULL DEFAULT CURRENT_DATE,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS medical_record_id uuid REFERENCES medical_records(id) ON DELETE SET NULL`);

    // ─── Atestados médicos ────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS medical_certificates (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id       uuid        NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        patient_id      uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        surgery_id      uuid        REFERENCES surgeries(id) ON DELETE SET NULL,
        medical_record_id uuid      REFERENCES medical_records(id) ON DELETE SET NULL,
        cid10_code      text,
        cid10_desc      text,
        rest_days       integer     NOT NULL DEFAULT 1,
        justification   text,
        issued_at       date        NOT NULL DEFAULT CURRENT_DATE,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`ALTER TABLE medical_certificates ADD COLUMN IF NOT EXISTS medical_record_id uuid REFERENCES medical_records(id) ON DELETE SET NULL`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prescriptions_patient  ON prescriptions(patient_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor   ON prescriptions(doctor_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prescriptions_medical_record ON prescriptions(medical_record_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_certificates_patient   ON medical_certificates(patient_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_certificates_medical_record ON medical_certificates(medical_record_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cid10_custom_doctor    ON cid10_custom(doctor_id)`);
    await query(`ALTER TABLE medical_certificates ADD COLUMN IF NOT EXISTS cid_version text`);
    await query(`ALTER TABLE medical_certificates ADD COLUMN IF NOT EXISTS cid_uri text`);

    // ─── CID-10 referência pública (FHIR GO) ────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS cid10_reference (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        code        text        NOT NULL UNIQUE,
        description text        NOT NULL,
        source      text        NOT NULL DEFAULT 'fhir-go',
        active      boolean     NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cid10_reference_code ON cid10_reference(code)`);

    // ─── Múltiplos CIDs por atestado ────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS medical_certificate_cids (
        id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        certificate_id uuid        NOT NULL REFERENCES medical_certificates(id) ON DELETE CASCADE,
        position       integer     NOT NULL DEFAULT 1,
        code           text        NOT NULL,
        description    text,
        cid_version    text,
        cid_uri        text,
        source         text,
        created_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_medical_certificate_cids_cert ON medical_certificate_cids(certificate_id)`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_medical_certificate_cids_cert_code_version
        ON medical_certificate_cids(certificate_id, code, COALESCE(cid_version, ''))
    `);

    // ─── Clínicas ─────────────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS clinics (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text        NOT NULL,
        cnpj        text        UNIQUE,
        phone       text,
        email       text,
        address     text,
        city        text,
        state       text,
        zip_code    text,
        logo_url    text,
        active      boolean     NOT NULL DEFAULT true,
        created_by  uuid        REFERENCES doctors(id) ON DELETE SET NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── Membros da clínica (médicos + recepcionistas) ────────────
    await query(`
      CREATE TABLE IF NOT EXISTS clinic_members (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id    uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        member_id    uuid        NOT NULL,
        member_type  text        NOT NULL CHECK (member_type IN ('doctor','receptionist')),
        role         text        NOT NULL DEFAULT 'member'
                                 CHECK (role IN ('owner','admin','member')),
        active       boolean     NOT NULL DEFAULT true,
        joined_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (clinic_id, member_id, member_type)
      )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_clinics_created_by  ON clinics(created_by)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_clinic_members_clinic ON clinic_members(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_clinic_members_member ON clinic_members(member_id, member_type)`);

    // ─── escopo de agenda por receptionist (todos ou multiplos medicos) ───
    await query(`
      CREATE TABLE IF NOT EXISTS receptionist_doctor_scope (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_member_id uuid NOT NULL REFERENCES clinic_members(id) ON DELETE CASCADE,
        scope_type       text NOT NULL DEFAULT 'ALL_DOCTORS'
                          CHECK (scope_type IN ('ALL_DOCTORS','ONE_DOCTOR')),
        doctor_id        uuid REFERENCES doctors(id) ON DELETE SET NULL,
        active           boolean NOT NULL DEFAULT true,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`ALTER TABLE receptionist_doctor_scope DROP CONSTRAINT IF EXISTS receptionist_doctor_scope_clinic_member_id_key`);
    await query(`DROP INDEX IF EXISTS receptionist_doctor_scope_clinic_member_id_key`);
    await query(`CREATE INDEX IF NOT EXISTS idx_receptionist_scope_member ON receptionist_doctor_scope(clinic_member_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_receptionist_scope_doctor ON receptionist_doctor_scope(doctor_id)`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_receptionist_scope_all_active
        ON receptionist_doctor_scope(clinic_member_id)
       WHERE active = true AND scope_type = 'ALL_DOCTORS'
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_receptionist_scope_doctor_active
        ON receptionist_doctor_scope(clinic_member_id, doctor_id)
       WHERE active = true AND scope_type = 'ONE_DOCTOR' AND doctor_id IS NOT NULL
    `);
    await query(`
      DELETE FROM receptionist_doctor_scope s
      WHERE s.scope_type = 'ONE_DOCTOR'
        AND s.doctor_id IS NULL
    `);
    await query(`DROP TRIGGER IF EXISTS trg_receptionist_doctor_scope_updated_at ON receptionist_doctor_scope`);
    await query(`
      CREATE TRIGGER trg_receptionist_doctor_scope_updated_at
      BEFORE UPDATE ON receptionist_doctor_scope
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);
    await query(`
      INSERT INTO receptionist_doctor_scope (clinic_member_id, scope_type, doctor_id, active)
      SELECT cm.id, 'ALL_DOCTORS', NULL, true
      FROM clinic_members cm
      WHERE cm.member_type = 'receptionist'
        AND cm.active = true
        AND NOT EXISTS (
          SELECT 1
          FROM receptionist_doctor_scope s
          WHERE s.clinic_member_id = cm.id
            AND s.active = true
        )
    `);

    // ─── isolamento SaaS por clínica ─────────────────────────────
    await query(`ALTER TABLE patients                  ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE consultations             ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE medical_records           ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE surgeries                 ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE patient_clinical_followups ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE document_templates        ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE surgery_documents         ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE prescriptions             ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE medical_certificates      ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE procedure_types           ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE procedure_type_categories ADD COLUMN IF NOT EXISTS clinic_id uuid`);
    await query(`ALTER TABLE cid10_custom              ADD COLUMN IF NOT EXISTS clinic_id uuid`);

    await query(`
      UPDATE consultations c
         SET clinic_id = COALESCE(
           c.clinic_id,
           (SELECT cm.clinic_id
              FROM clinic_members cm
              JOIN clinics cl ON cl.id = cm.clinic_id
             WHERE cm.member_id = c.doctor_id
               AND cm.member_type = 'doctor'
               AND cm.active = true
               AND cl.active = true
             ORDER BY cm.joined_at ASC NULLS LAST
             LIMIT 1),
           (SELECT cl2.id
              FROM clinics cl2
             WHERE cl2.created_by = c.doctor_id
               AND cl2.active = true
             ORDER BY cl2.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE c.clinic_id IS NULL
    `);

    await query(`
      UPDATE surgeries s
         SET clinic_id = COALESCE(
           s.clinic_id,
           (SELECT cm.clinic_id
              FROM clinic_members cm
              JOIN clinics cl ON cl.id = cm.clinic_id
             WHERE cm.member_id = s.doctor_id
               AND cm.member_type = 'doctor'
               AND cm.active = true
               AND cl.active = true
             ORDER BY cm.joined_at ASC NULLS LAST
             LIMIT 1),
           (SELECT cl2.id
              FROM clinics cl2
             WHERE cl2.created_by = s.doctor_id
               AND cl2.active = true
             ORDER BY cl2.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE s.clinic_id IS NULL
    `);

    await query(`
      UPDATE medical_records mr
         SET clinic_id = COALESCE(
           mr.clinic_id,
           (SELECT cm.clinic_id
              FROM clinic_members cm
              JOIN clinics cl ON cl.id = cm.clinic_id
             WHERE cm.member_id = mr.doctor_id
               AND cm.member_type = 'doctor'
               AND cm.active = true
               AND cl.active = true
             ORDER BY cm.joined_at ASC NULLS LAST
             LIMIT 1),
           (SELECT cl2.id
              FROM clinics cl2
             WHERE cl2.created_by = mr.doctor_id
               AND cl2.active = true
             ORDER BY cl2.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE mr.clinic_id IS NULL
    `);

    await query(`
      UPDATE prescriptions pr
         SET clinic_id = COALESCE(
           pr.clinic_id,
           (SELECT cm.clinic_id
              FROM clinic_members cm
              JOIN clinics cl ON cl.id = cm.clinic_id
             WHERE cm.member_id = pr.doctor_id
               AND cm.member_type = 'doctor'
               AND cm.active = true
               AND cl.active = true
             ORDER BY cm.joined_at ASC NULLS LAST
             LIMIT 1),
           (SELECT cl2.id
              FROM clinics cl2
             WHERE cl2.created_by = pr.doctor_id
               AND cl2.active = true
             ORDER BY cl2.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE pr.clinic_id IS NULL
    `);

    await query(`
      UPDATE medical_certificates mc
         SET clinic_id = COALESCE(
           mc.clinic_id,
           (SELECT cm.clinic_id
              FROM clinic_members cm
              JOIN clinics cl ON cl.id = cm.clinic_id
             WHERE cm.member_id = mc.doctor_id
               AND cm.member_type = 'doctor'
               AND cm.active = true
               AND cl.active = true
             ORDER BY cm.joined_at ASC NULLS LAST
             LIMIT 1),
           (SELECT cl2.id
              FROM clinics cl2
             WHERE cl2.created_by = mc.doctor_id
               AND cl2.active = true
             ORDER BY cl2.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE mc.clinic_id IS NULL
    `);

    await query(`
      UPDATE patients p
         SET clinic_id = COALESCE(
           p.clinic_id,
           (SELECT c.clinic_id
              FROM consultations c
             WHERE c.patient_id = p.id AND c.clinic_id IS NOT NULL
             ORDER BY c.created_at ASC NULLS LAST
             LIMIT 1),
           (SELECT s.clinic_id
              FROM surgeries s
             WHERE s.patient_id = p.id AND s.clinic_id IS NOT NULL
             ORDER BY s.created_at ASC NULLS LAST
             LIMIT 1),
           (SELECT mr.clinic_id
              FROM medical_records mr
             WHERE mr.patient_id = p.id AND mr.clinic_id IS NOT NULL
             ORDER BY mr.created_at ASC NULLS LAST
             LIMIT 1)
         )
       WHERE p.clinic_id IS NULL
    `);

    await query(`
      UPDATE consultations c
         SET clinic_id = COALESCE(c.clinic_id, p.clinic_id)
        FROM patients p
       WHERE c.patient_id = p.id
         AND c.clinic_id IS NULL
    `);
    await query(`
      UPDATE medical_records mr
         SET clinic_id = COALESCE(mr.clinic_id, p.clinic_id)
        FROM patients p
       WHERE mr.patient_id = p.id
         AND mr.clinic_id IS NULL
    `);
    await query(`
      UPDATE surgeries s
         SET clinic_id = COALESCE(s.clinic_id, p.clinic_id)
        FROM patients p
       WHERE s.patient_id = p.id
         AND s.clinic_id IS NULL
    `);
    await query(`
      UPDATE patient_clinical_followups f
         SET clinic_id = COALESCE(f.clinic_id, p.clinic_id)
        FROM patients p
       WHERE f.patient_id = p.id
         AND f.clinic_id IS NULL
    `);
    await query(`
      UPDATE surgery_documents sd
         SET clinic_id = COALESCE(sd.clinic_id, s.clinic_id)
        FROM surgeries s
       WHERE sd.surgery_id = s.id
         AND sd.clinic_id IS NULL
    `);
    await query(`
      UPDATE prescriptions pr
         SET clinic_id = COALESCE(pr.clinic_id, p.clinic_id)
        FROM patients p
       WHERE pr.patient_id = p.id
         AND pr.clinic_id IS NULL
    `);
    await query(`
      UPDATE medical_certificates mc
         SET clinic_id = COALESCE(mc.clinic_id, p.clinic_id)
        FROM patients p
       WHERE mc.patient_id = p.id
         AND mc.clinic_id IS NULL
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_patients_clinic_id            ON patients(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_consultations_clinic_id       ON consultations(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_medical_records_clinic_id     ON medical_records(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_surgeries_clinic_id           ON surgeries(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_followups_clinic_id           ON patient_clinical_followups(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_surgery_docs_clinic_id        ON surgery_documents(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prescriptions_clinic_id       ON prescriptions(clinic_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_medical_certificates_clinic_id ON medical_certificates(clinic_id)`);

    // ─── indexes (idempotentes) ───────────────────────────────────
    await query(`CREATE INDEX IF NOT EXISTS idx_doctor_certificates_doctor ON doctor_certificates(doctor_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_document_created     ON signature_audit_logs(document_id, created_at DESC)`);
    await query(`DROP TRIGGER IF EXISTS trg_medical_records_updated_at ON medical_records`);
    await query(`
      CREATE TRIGGER trg_medical_records_updated_at
      BEFORE UPDATE ON medical_records
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);
    await query(`DROP TRIGGER IF EXISTS trg_patient_clinical_followups_updated_at ON patient_clinical_followups`);
    await query(`
      CREATE TRIGGER trg_patient_clinical_followups_updated_at
      BEFORE UPDATE ON patient_clinical_followups
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // ─── surgeries status constraint ─────────────────────────────
    await query(`ALTER TABLE surgeries DROP CONSTRAINT IF EXISTS surgeries_status_check`);
    await query(`
      ALTER TABLE surgeries ADD CONSTRAINT surgeries_status_check
        CHECK (status IN ('DRAFT','scheduled','completed','cancelled','AWAITING_SIGNATURE','SIGNED'))
    `);

    // ─── FINANCEIRO / CAIXA ────────────────────────────────────────
    // Preço do procedimento (usado para gerar a cobrança no caixa)
    await query(`ALTER TABLE procedure_types ADD COLUMN IF NOT EXISTS price numeric(12,2)`);

    // Sessões de caixa (abertura/fechamento por turno/dia)
    await query(`
      CREATE TABLE IF NOT EXISTS cash_sessions (
        id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id                uuid        NOT NULL,
        status                   text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
        opening_amount           numeric(12,2) NOT NULL DEFAULT 0,
        opened_by_type           text        NOT NULL CHECK (opened_by_type IN ('doctor','receptionist')),
        opened_by_id             uuid        NOT NULL,
        opened_at                timestamptz NOT NULL DEFAULT now(),
        closing_amount_informed  numeric(12,2),
        closing_expected_cash    numeric(12,2),
        closing_difference       numeric(12,2),
        closing_totals_json      jsonb,
        closing_notes            text,
        closed_by_type           text        CHECK (closed_by_type IN ('doctor','receptionist')),
        closed_by_id             uuid,
        closed_at                timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_sessions_clinic ON cash_sessions(clinic_id, status)`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_sessions_one_open_per_clinic
        ON cash_sessions(clinic_id) WHERE status = 'OPEN'
    `);
    await query(`DROP TRIGGER IF EXISTS trg_cash_sessions_updated_at ON cash_sessions`);
    await query(`
      CREATE TRIGGER trg_cash_sessions_updated_at
      BEFORE UPDATE ON cash_sessions
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // Lançamentos do caixa (cobranças vinculadas a procedimento/consulta + recebimento)
    await query(`
      CREATE TABLE IF NOT EXISTS cash_transactions (
        id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id            uuid        NOT NULL,
        patient_id           uuid        NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        doctor_id            uuid        REFERENCES doctors(id) ON DELETE SET NULL,
        procedure_type_id    uuid        REFERENCES procedure_types(id) ON DELETE SET NULL,
        surgery_id           uuid        REFERENCES surgeries(id) ON DELETE SET NULL,
        consultation_id      uuid        REFERENCES consultations(id) ON DELETE SET NULL,
        description          text        NOT NULL,
        amount               numeric(12,2) NOT NULL DEFAULT 0,
        discount_amount      numeric(12,2) NOT NULL DEFAULT 0,
        status               text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELED')),
        payment_method       text        CHECK (payment_method IN ('DINHEIRO','CARTAO_DEBITO','CARTAO_CREDITO','PIX','CONVENIO')),
        origin               text        NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','AUTO_SIGNATURE')),
        cash_session_id      uuid        REFERENCES cash_sessions(id) ON DELETE SET NULL,
        created_by_type      text        NOT NULL DEFAULT 'system' CHECK (created_by_type IN ('doctor','receptionist','system')),
        created_by_id        uuid,
        received_by_type     text        CHECK (received_by_type IN ('doctor','receptionist')),
        received_by_id       uuid,
        paid_at              timestamptz,
        canceled_at          timestamptz,
        authorized_by_owner_id uuid      REFERENCES doctors(id) ON DELETE SET NULL,
        notes                text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_clinic     ON cash_transactions(clinic_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_patient   ON cash_transactions(patient_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_surgery   ON cash_transactions(surgery_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_session   ON cash_transactions(cash_session_id)`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_transactions_surgery_auto
        ON cash_transactions(surgery_id)
        WHERE origin = 'AUTO_SIGNATURE' AND surgery_id IS NOT NULL
    `);
    await query(`DROP TRIGGER IF EXISTS trg_cash_transactions_updated_at ON cash_transactions`);
    await query(`
      CREATE TRIGGER trg_cash_transactions_updated_at
      BEFORE UPDATE ON cash_transactions
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // Páginas do módulo Financeiro no sistema de permissões (somente se a tabela já existir —
    // ela é criada pelo supabase/schema.sql junto com clinics/clinic_members).
    //
    // OBS: usamos um ÚNICO código de página ('financeiro.caixa') para a tela do Caixa.
    // Uma versão anterior desta migração criava também um código "pai" ('financeiro'),
    // o que causava um bug: como a visibilidade do menu libera o acesso se QUALQUER UM
    // dos códigos estiver permitido, o dono da clínica precisava desmarcar os DOIS
    // registros para realmente bloquear o acesso — desmarcando só um (o que parecia
    // ser o certo), o usuário continuava enxergando e usando a tela normalmente.
    // Por isso removemos o código "pai" abaixo e ficamos com um único código por tela.
    await query(`
      DO $$
      BEGIN
        IF to_regclass('public.app_pages') IS NOT NULL THEN
          DELETE FROM app_pages WHERE code = 'financeiro';

          INSERT INTO app_pages (code, name, menu_group, sort_order, member_type, is_owner_only, default_can_view, default_can_create, default_can_update, default_can_delete)
          VALUES
            ('financeiro.caixa',  'Caixa', 'financeiro', 100, 'both', false, true, true, true, false)
          ON CONFLICT (code) DO UPDATE
          SET name = excluded.name,
              menu_group = excluded.menu_group,
              sort_order = excluded.sort_order,
              member_type = excluded.member_type,
              active = true,
              updated_at = now();
        END IF;
      END $$;
    `);

    // ─── FINANCEIRO: relatórios, contas a pagar, sangria/aporte, comissão ──

    // Comissão do médico (% de repasse). Só o proprietário da clínica pode editar
    // (checado no backend, não é um app_pages/permissão comum).
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS commission_percentage numeric(5,2)`);

    // Despesas / Contas a Pagar
    await query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id         uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        description       text        NOT NULL,
        category          text        NOT NULL DEFAULT 'OUTROS' CHECK (category IN ('ALUGUEL','FORNECEDORES','SALARIOS','IMPOSTOS','MARKETING','EQUIPAMENTOS','MANUTENCAO','OUTROS')),
        supplier_name     text,
        amount            numeric(12,2) NOT NULL DEFAULT 0,
        due_date          date        NOT NULL,
        status            text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELED')),
        paid_at           timestamptz,
        payment_method    text        CHECK (payment_method IN ('DINHEIRO','CARTAO_DEBITO','CARTAO_CREDITO','PIX','TRANSFERENCIA','BOLETO')),
        is_recurring      boolean     NOT NULL DEFAULT false,
        notes             text,
        created_by_type   text        NOT NULL DEFAULT 'doctor' CHECK (created_by_type IN ('doctor','receptionist','system')),
        created_by_id     uuid,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_expenses_clinic ON expenses(clinic_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_expenses_due_date ON expenses(due_date)`);
    await query(`DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses`);
    await query(`
      CREATE TRIGGER trg_expenses_updated_at
      BEFORE UPDATE ON expenses
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // Sangria (retirada) e Aporte (reforço) de caixa dentro de uma sessão aberta
    await query(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id         uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        cash_session_id   uuid        NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
        type              text        NOT NULL CHECK (type IN ('SANGRIA','APORTE')),
        amount            numeric(12,2) NOT NULL,
        reason            text,
        created_by_type   text        NOT NULL CHECK (created_by_type IN ('doctor','receptionist')),
        created_by_id     uuid        NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_movements_clinic ON cash_movements(clinic_id)`);

    // Páginas do módulo de relatórios financeiros (somente médico/proprietário — dados sensíveis)
    await query(`
      DO $$
      BEGIN
        IF to_regclass('public.app_pages') IS NOT NULL THEN
          INSERT INTO app_pages (code, name, menu_group, sort_order, member_type, is_owner_only, default_can_view, default_can_create, default_can_update, default_can_delete)
          VALUES
            ('financeiro.relatorios', 'Relatórios e Dashboard', 'financeiro', 101, 'doctor', false, true, false, false, false),
            ('financeiro.despesas',   'Contas a Pagar',         'financeiro', 102, 'doctor', false, true, true,  true,  true)
          ON CONFLICT (code) DO UPDATE
          SET name = excluded.name,
              menu_group = excluded.menu_group,
              sort_order = excluded.sort_order,
              member_type = excluded.member_type,
              active = true,
              updated_at = now();
        END IF;
      END $$;
    `);

    // ─── TELEMEDICINA / TELECONSULTA (Jitsi via JaaS) ──────────────
    await query(`
      ALTER TABLE consultations ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'PRESENCIAL'
    `);
    await query(`ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_modality_check`);
    await query(`
      ALTER TABLE consultations ADD CONSTRAINT consultations_modality_check
        CHECK (modality IN ('PRESENCIAL','TELECONSULTA'))
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS teleconsultation_sessions (
        id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        consultation_id             uuid        NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
        clinic_id                   uuid,
        doctor_id                   uuid        NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        patient_id                  uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        room_uuid                   uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        access_token                text        NOT NULL UNIQUE,
        access_token_expires_at     timestamptz NOT NULL,
        status                      text        NOT NULL DEFAULT 'AGUARDANDO'
                                     CHECK (status IN ('AGUARDANDO','EM_ANDAMENTO','FINALIZADA','EXPIRADA')),
        patient_consent_version     text,
        patient_consent_at          timestamptz,
        patient_consent_ip          text,
        patient_consent_user_agent  text,
        doctor_joined_at            timestamptz,
        patient_joined_at           timestamptz,
        started_at                  timestamptz,
        ended_at                    timestamptz,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_sessions_room    ON teleconsultation_sessions(room_uuid)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_sessions_token   ON teleconsultation_sessions(access_token)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_sessions_doctor  ON teleconsultation_sessions(doctor_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_sessions_patient ON teleconsultation_sessions(patient_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_sessions_clinic  ON teleconsultation_sessions(clinic_id)`);

    await query(`DROP TRIGGER IF EXISTS trg_teleconsultation_sessions_updated_at ON teleconsultation_sessions`);
    await query(`
      CREATE TRIGGER trg_teleconsultation_sessions_updated_at
      BEFORE UPDATE ON teleconsultation_sessions
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // Trilha de auditoria em cadeia de hash (mesmo espirito de signature_audit_logs,
    // porem escopada a sessao de teleconsulta em vez de documento assinado).
    await query(`
      CREATE TABLE IF NOT EXISTS teleconsultation_audit_logs (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id      uuid        REFERENCES teleconsultation_sessions(id) ON DELETE SET NULL,
        event_type      text        NOT NULL,
        actor_type      text        CHECK (actor_type IN ('doctor','patient','system')),
        actor_id        uuid,
        ip_address      text,
        user_agent      text,
        prev_event_hash text,
        event_hash      text        NOT NULL,
        payload_json    jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_teleconsultation_audit_session ON teleconsultation_audit_logs(session_id, created_at)`);

    // ─── CONVÊNIOS / GLOSAS ─────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS insurance_operators (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id    uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        name         text        NOT NULL,
        cnpj         text,
        ans_registry text,
        contact_phone text,
        contact_email text,
        active       boolean     NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_operators_clinic ON insurance_operators(clinic_id)`);
    await query(`DROP TRIGGER IF EXISTS trg_insurance_operators_updated_at ON insurance_operators`);
    await query(`CREATE TRIGGER trg_insurance_operators_updated_at BEFORE UPDATE ON insurance_operators FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_plans (
        id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        operator_id    uuid        NOT NULL REFERENCES insurance_operators(id) ON DELETE CASCADE,
        name           text        NOT NULL,
        segmentation   text,
        coverage_area  text,
        active         boolean     NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_plans_operator ON insurance_plans(operator_id)`);

    await query(`
      CREATE TABLE IF NOT EXISTS clinic_insurance_contracts (
        id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id                       uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        operator_id                     uuid        NOT NULL REFERENCES insurance_operators(id) ON DELETE CASCADE,
        cbhpm_percentage                numeric(6,2),
        requires_authorization_default  boolean     NOT NULL DEFAULT false,
        has_coparticipation             boolean     NOT NULL DEFAULT false,
        coparticipation_percentage      numeric(5,2),
        closing_day                     integer,
        glosa_appeal_deadline_days      integer     NOT NULL DEFAULT 30,
        active                          boolean     NOT NULL DEFAULT true,
        notes                          text,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now(),
        UNIQUE(clinic_id, operator_id)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_contracts_clinic ON clinic_insurance_contracts(clinic_id)`);
    await query(`DROP TRIGGER IF EXISTS trg_insurance_contracts_updated_at ON clinic_insurance_contracts`);
    await query(`CREATE TRIGGER trg_insurance_contracts_updated_at BEFORE UPDATE ON clinic_insurance_contracts FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    await query(`
      CREATE TABLE IF NOT EXISTS patient_insurance (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id          uuid        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        contract_id         uuid        NOT NULL REFERENCES clinic_insurance_contracts(id) ON DELETE CASCADE,
        plan_id             uuid        REFERENCES insurance_plans(id) ON DELETE SET NULL,
        card_number         text        NOT NULL,
        card_validity       date,
        holder_patient_id   uuid        REFERENCES patients(id) ON DELETE SET NULL,
        coverage_start_date date        NOT NULL DEFAULT CURRENT_DATE,
        status              text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CANCELED')),
        notes               text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_insurance_patient ON patient_insurance(patient_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_patient_insurance_contract ON patient_insurance(contract_id)`);
    await query(`DROP TRIGGER IF EXISTS trg_patient_insurance_updated_at ON patient_insurance`);
    await query(`CREATE TRIGGER trg_patient_insurance_updated_at BEFORE UPDATE ON patient_insurance FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_procedure_table (
        id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id            uuid        NOT NULL REFERENCES clinic_insurance_contracts(id) ON DELETE CASCADE,
        tuss_code              text,
        cbhpm_code             text,
        description            text        NOT NULL,
        negotiated_value       numeric(12,2) NOT NULL DEFAULT 0,
        requires_authorization boolean,
        waiting_period_days    integer     NOT NULL DEFAULT 0,
        active                 boolean     NOT NULL DEFAULT true,
        created_at             timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_proc_table_contract ON insurance_procedure_table(contract_id)`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_billing_batches (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id        uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        contract_id      uuid        NOT NULL REFERENCES clinic_insurance_contracts(id) ON DELETE CASCADE,
        competence_month date        NOT NULL,
        status           text        NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','ENVIADO','CONCILIADO')),
        sent_at          timestamptz,
        returned_at      timestamptz,
        total_billed     numeric(12,2) NOT NULL DEFAULT 0,
        total_paid       numeric(12,2) NOT NULL DEFAULT 0,
        total_glossed    numeric(12,2) NOT NULL DEFAULT 0,
        notes            text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_batches_clinic ON insurance_billing_batches(clinic_id, status)`);
    await query(`DROP TRIGGER IF EXISTS trg_insurance_batches_updated_at ON insurance_billing_batches`);
    await query(`CREATE TRIGGER trg_insurance_batches_updated_at BEFORE UPDATE ON insurance_billing_batches FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_claims (
        id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id             uuid        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        patient_insurance_id  uuid        NOT NULL REFERENCES patient_insurance(id) ON DELETE RESTRICT,
        doctor_id             uuid        REFERENCES doctors(id) ON DELETE SET NULL,
        consultation_id       uuid        REFERENCES consultations(id) ON DELETE SET NULL,
        surgery_id            uuid        REFERENCES surgeries(id) ON DELETE SET NULL,
        type                  text        NOT NULL DEFAULT 'CONSULTA' CHECK (type IN ('CONSULTA','SADT','INTERNACAO','HONORARIO')),
        status                text        NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO','EMITIDA','ENVIADA','PAGA','GLOSADA_PARCIAL','GLOSADA_TOTAL','EM_RECURSO','FINALIZADA')),
        authorization_number  text,
        issued_at             timestamptz,
        sent_at               timestamptz,
        batch_id              uuid        REFERENCES insurance_billing_batches(id) ON DELETE SET NULL,
        total_value           numeric(12,2) NOT NULL DEFAULT 0,
        total_paid            numeric(12,2),
        total_glossed         numeric(12,2),
        glosa_reason          text,
        notes                 text,
        created_by_type       text        CHECK (created_by_type IN ('doctor','receptionist')),
        created_by_id         uuid,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_claims_clinic ON insurance_claims(clinic_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_claims_batch ON insurance_claims(batch_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_claims_patient_ins ON insurance_claims(patient_insurance_id)`);
    await query(`DROP TRIGGER IF EXISTS trg_insurance_claims_updated_at ON insurance_claims`);
    await query(`CREATE TRIGGER trg_insurance_claims_updated_at BEFORE UPDATE ON insurance_claims FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_claim_items (
        id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id           uuid        NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
        procedure_table_id uuid        REFERENCES insurance_procedure_table(id) ON DELETE SET NULL,
        description        text        NOT NULL,
        quantity           integer     NOT NULL DEFAULT 1,
        unit_value         numeric(12,2) NOT NULL DEFAULT 0,
        created_at         timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_claim_items_claim ON insurance_claim_items(claim_id)`);

    await query(`
      CREATE TABLE IF NOT EXISTS insurance_glosa_appeals (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id         uuid        NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
        protocol_date    date        NOT NULL DEFAULT CURRENT_DATE,
        justification    text        NOT NULL,
        status           text        NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ACEITO','NEGADO')),
        response_date    date,
        response_notes   text,
        created_by_type  text        CHECK (created_by_type IN ('doctor','receptionist')),
        created_by_id    uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_insurance_appeals_claim ON insurance_glosa_appeals(claim_id)`);
    await query(`DROP TRIGGER IF EXISTS trg_insurance_appeals_updated_at ON insurance_glosa_appeals`);
    await query(`CREATE TRIGGER trg_insurance_appeals_updated_at BEFORE UPDATE ON insurance_glosa_appeals FOR EACH ROW EXECUTE PROCEDURE set_updated_at()`);

    // Páginas de permissão do módulo de Convênios
    await query(`
      DO $$
      BEGIN
        IF to_regclass('public.app_pages') IS NOT NULL THEN
          INSERT INTO app_pages (code, name, menu_group, sort_order, member_type, is_owner_only, default_can_view, default_can_create, default_can_update, default_can_delete)
          VALUES
            ('convenios',        'Convênios',        'convenios', 110, 'both', false, true, true, true, true),
            ('convenios.guias',  'Guias e Glosas',    'convenios', 111, 'both', false, true, true, true, false)
          ON CONFLICT (code) DO UPDATE
          SET name = excluded.name,
              menu_group = excluded.menu_group,
              sort_order = excluded.sort_order,
              member_type = excluded.member_type,
              active = true,
              updated_at = now();
        END IF;
      END $$;
    `);

    // ─── CAIXA: recebimento MISTO (mais de uma forma de pagamento por lancamento,
    // como em um PDV) ──
    //
    // Antes, cada cash_transaction so guardava UMA forma de pagamento. Agora um
    // recebimento pode ser dividido em "pernas" (ex.: parte em dinheiro, parte no
    // Pix) — cada perna vira uma linha aqui. A soma das pernas de um lancamento
    // tem que ser igual a (amount - discount_amount); essa validacao fica no
    // backend (cashierRoutes.js), nao no banco.
    await query(`
      CREATE TABLE IF NOT EXISTS cash_transaction_payments (
        id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id uuid        NOT NULL REFERENCES cash_transactions(id) ON DELETE CASCADE,
        payment_method text        NOT NULL CHECK (payment_method IN ('DINHEIRO','CARTAO_DEBITO','CARTAO_CREDITO','PIX','CONVENIO')),
        amount         numeric(12,2) NOT NULL CHECK (amount > 0),
        created_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cash_transaction_payments_tx ON cash_transaction_payments(transaction_id)`);

    // 'MISTO' passa a ser um valor valido de payment_method na transacao (marcador
    // de que ela foi dividida em varias formas — o detalhe de cada perna fica em
    // cash_transaction_payments). O nome do constraint abaixo e o gerado por
    // padrao pelo Postgres pra um CHECK inline sem nome explicito na criacao
    // original da tabela.
    await query(`ALTER TABLE cash_transactions DROP CONSTRAINT IF EXISTS cash_transactions_payment_method_check`);
    await query(`
      ALTER TABLE cash_transactions ADD CONSTRAINT cash_transactions_payment_method_check
        CHECK (payment_method IN ('DINHEIRO','CARTAO_DEBITO','CARTAO_CREDITO','PIX','CONVENIO','MISTO'))
    `);

    // Backfill: todo recebimento PAGO que existia antes dessa migracao tinha uma
    // unica forma de pagamento — cria a "perna" correspondente pra ele tambem
    // aparecer certinho nos relatorios que agora leem de cash_transaction_payments
    // (fechamento de caixa, conciliacao, forma de pagamento, evolucao de receita).
    // Idempotente (NOT EXISTS), pode rodar em toda inicializacao sem duplicar.
    await query(`
      INSERT INTO cash_transaction_payments (transaction_id, payment_method, amount)
      SELECT ct.id, ct.payment_method, ROUND((ct.amount - ct.discount_amount)::numeric, 2)
        FROM cash_transactions ct
       WHERE ct.status = 'PAID'
         AND ct.payment_method IS NOT NULL
         AND ct.payment_method != 'MISTO'
         AND (ct.amount - ct.discount_amount) > 0
         AND NOT EXISTS (SELECT 1 FROM cash_transaction_payments ctp WHERE ctp.transaction_id = ct.id)
    `);

    // ─── CONVENIOS: prazo medio de recebimento por operadora (usado no relatorio
    // de Projecao de Recebiveis de Convenio) ──
    await query(`ALTER TABLE insurance_operators ADD COLUMN IF NOT EXISTS average_payment_days integer NOT NULL DEFAULT 45`);

    // ═══════════════════════════════════════════════════════════════════
    // ESTOQUE — produtos/insumos, movimentacoes, receita por tipo de
    // procedimento (quais produtos ele usa + modo de preparo), e entrada
    // por XML de NFe (com deteccao de boleto/duplicata pra Contas a Pagar)
    // ═══════════════════════════════════════════════════════════════════
    await query(`
      CREATE TABLE IF NOT EXISTS stock_products (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id         uuid        REFERENCES clinics(id) ON DELETE CASCADE,
        name              text        NOT NULL,
        description       text,
        category          text,
        unit              text        NOT NULL DEFAULT 'UN',
        ncm_code          text,
        ean_code          text,
        minimum_quantity  numeric(12,3) NOT NULL DEFAULT 0,
        supplier_name     text,
        active            boolean     NOT NULL DEFAULT true,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_stock_products_clinic ON stock_products(clinic_id, active)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_stock_products_ncm ON stock_products(clinic_id, ncm_code)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_stock_products_ean ON stock_products(clinic_id, ean_code)`);
    await query(`DROP TRIGGER IF EXISTS trg_stock_products_updated_at ON stock_products`);
    await query(`
      CREATE TRIGGER trg_stock_products_updated_at
      BEFORE UPDATE ON stock_products
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // O saldo do produto e sempre a SOMA das movimentacoes (nunca um campo
    // solto que possa desalinhar) — por isso "quantity" aqui e um delta
    // com sinal: entrada positiva, saida/perda/consumo negativa. Ajuste
    // pode ser nos dois sentidos (correcao de inventario).
    await query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id         uuid        REFERENCES clinics(id) ON DELETE CASCADE,
        product_id        uuid        NOT NULL REFERENCES stock_products(id) ON DELETE CASCADE,
        type              text        NOT NULL CHECK (type IN ('ENTRADA','SAIDA','AJUSTE','PERDA','CONSUMO_PROCEDIMENTO')),
        quantity          numeric(12,3) NOT NULL CHECK (quantity <> 0),
        unit_cost         numeric(12,4),
        total_cost        numeric(12,2),
        reason            text,
        reference_type    text CHECK (reference_type IN ('MANUAL','XML_IMPORT','PROCEDURE','ADJUSTMENT') OR reference_type IS NULL),
        reference_id      uuid,
        batch_number      text,
        expiration_date   date,
        created_by_type   text        CHECK (created_by_type IN ('DOCTOR','RECEPTIONIST','SYSTEM') OR created_by_type IS NULL),
        created_by_id     uuid,
        created_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stock_movements_sign_check CHECK (
          (type = 'ENTRADA' AND quantity > 0) OR
          (type IN ('SAIDA','PERDA','CONSUMO_PROCEDIMENTO') AND quantity < 0) OR
          (type = 'AJUSTE')
        )
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_clinic ON stock_movements(clinic_id, created_at DESC)`);

    // Receita/kit de cada TIPO de procedimento — quais produtos ele usa e
    // em que quantidade (o "modo de preparo" geral fica direto em
    // procedure_types.supplies_preparation; observacao por item fica aqui).
    await query(`
      CREATE TABLE IF NOT EXISTS procedure_type_products (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        procedure_type_id uuid        NOT NULL REFERENCES procedure_types(id) ON DELETE CASCADE,
        product_id        uuid        NOT NULL REFERENCES stock_products(id) ON DELETE CASCADE,
        quantity          numeric(12,3) NOT NULL DEFAULT 1,
        notes             text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE(procedure_type_id, product_id)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_proc_type_products_type ON procedure_type_products(procedure_type_id)`);
    await query(`ALTER TABLE procedure_types ADD COLUMN IF NOT EXISTS supplies_preparation text`);

    // Importacoes de XML de NFe — guarda a chave de acesso (44 digitos) pra
    // nunca processar a mesma nota duas vezes.
    await query(`
      CREATE TABLE IF NOT EXISTS stock_xml_imports (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id         uuid        REFERENCES clinics(id) ON DELETE CASCADE,
        access_key        text,
        nfe_number        text,
        nfe_series        text,
        supplier_name     text,
        supplier_cnpj     text,
        issue_date        timestamptz,
        total_value       numeric(12,2),
        xml_filename      text,
        items_count       integer     NOT NULL DEFAULT 0,
        matched_count     integer     NOT NULL DEFAULT 0,
        new_products_count integer    NOT NULL DEFAULT 0,
        expenses_created  integer     NOT NULL DEFAULT 0,
        imported_by_type  text        CHECK (imported_by_type IN ('DOCTOR','RECEPTIONIST') OR imported_by_type IS NULL),
        imported_by_id    uuid,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_xml_imports_access_key ON stock_xml_imports(clinic_id, access_key) WHERE access_key IS NOT NULL`);

    // Rastreio de origem em Contas a Pagar — pra saber que aquela conta
    // veio de um boleto/duplicata detectado num XML de estoque importado
    // (e pra nao duplicar, evitar reimportar a mesma nota gerando conta de novo).
    await query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source_type text`);
    await query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source_id uuid`);
    await query(`CREATE INDEX IF NOT EXISTS idx_expenses_source ON expenses(source_type, source_id)`);

    // Pagina do Estoque no catalogo de permissoes — 'both' porque, na pratica,
    // quem recebe a mercadoria e da entrada no sistema costuma ser a recepcao,
    // mas o medico tambem precisa poder ver/gerenciar.
    await query(`
      DO $$
      BEGIN
        IF to_regclass('public.app_pages') IS NOT NULL THEN
          INSERT INTO app_pages (code, name, menu_group, sort_order, member_type, is_owner_only, default_can_view, default_can_create, default_can_update, default_can_delete)
          VALUES
            ('estoque', 'Estoque', 'estoque', 110, 'both', false, true, true, true, false)
          ON CONFLICT (code) DO UPDATE
          SET name = excluded.name,
              menu_group = excluded.menu_group,
              sort_order = excluded.sort_order,
              member_type = excluded.member_type,
              active = true,
              updated_at = now();
        END IF;
      END $$;
    `);

    // ═══════════════════════════════════════════════════════════════════
    // PERFIL — campos editáveis (médico e recepcionista)
    // ═══════════════════════════════════════════════════════════════════
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS phone text`);
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS bio text`);
    await query(`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS photo_url text`);
    await query(`ALTER TABLE receptionists ADD COLUMN IF NOT EXISTS phone text`);
    await query(`ALTER TABLE receptionists ADD COLUMN IF NOT EXISTS photo_url text`);

    // ═══════════════════════════════════════════════════════════════════
    // PORTFÓLIO PÚBLICO DO MÉDICO — vitrine/"landing page" com WhatsApp e
    // agenda (disponibilidade lida do Google Calendar já conectado)
    // ═══════════════════════════════════════════════════════════════════
    await query(`
      CREATE TABLE IF NOT EXISTS doctor_portfolios (
        id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id                   uuid        NOT NULL UNIQUE REFERENCES doctors(id) ON DELETE CASCADE,
        slug                        text        UNIQUE,
        published                   boolean     NOT NULL DEFAULT false,
        headline                    text,
        whatsapp_number             text,
        whatsapp_message_template   text        NOT NULL DEFAULT 'Olá! Vim pelo seu portfólio e gostaria de agendar uma consulta.',
        theme_primary_color         text        NOT NULL DEFAULT '#0f4c81',
        theme_accent_color          text        NOT NULL DEFAULT '#10b981',
        theme_font                  text        NOT NULL DEFAULT 'inter',
        theme_layout                text        NOT NULL DEFAULT 'classico',
        theme_nav_style              text       NOT NULL DEFAULT 'fixa',
        cover_photo_url              text,
        logo_url                     text,
        show_agenda                  boolean     NOT NULL DEFAULT true,
        agenda_slot_minutes          integer     NOT NULL DEFAULT 30,
        agenda_days_ahead            integer     NOT NULL DEFAULT 14,
        agenda_working_hours_start   text        NOT NULL DEFAULT '09:00',
        agenda_working_hours_end     text        NOT NULL DEFAULT '18:00',
        agenda_working_days          text        NOT NULL DEFAULT '1,2,3,4,5',
        updated_at                   timestamptz NOT NULL DEFAULT now(),
        created_at                   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_doctor_portfolios_slug ON doctor_portfolios(slug) WHERE published = true`);
    await query(`DROP TRIGGER IF EXISTS trg_doctor_portfolios_updated_at ON doctor_portfolios`);
    await query(`
      CREATE TRIGGER trg_doctor_portfolios_updated_at
      BEFORE UPDATE ON doctor_portfolios
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at()
    `);

    // Blocos de conteúdo do portfólio — ordenáveis, com posição da imagem
    // configurável (é o que dá o controle de "onde o texto/foto vai").
    await query(`
      CREATE TABLE IF NOT EXISTS doctor_portfolio_sections (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id    uuid        NOT NULL REFERENCES doctor_portfolios(id) ON DELETE CASCADE,
        type            text        NOT NULL CHECK (type IN ('TEXT','GALLERY','TESTIMONIALS')),
        title           text,
        content         text,
        image_position  text        NOT NULL DEFAULT 'right' CHECK (image_position IN ('left','right','top','none','full')),
        image_url       text,
        sort_order      integer     NOT NULL DEFAULT 0,
        visible         boolean     NOT NULL DEFAULT true,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_doctor_portfolio_sections_portfolio ON doctor_portfolio_sections(portfolio_id, sort_order)`);

    // Fotos da galeria de trabalho (várias por portfólio)
    await query(`
      CREATE TABLE IF NOT EXISTS doctor_portfolio_photos (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id    uuid        NOT NULL REFERENCES doctor_portfolios(id) ON DELETE CASCADE,
        url             text        NOT NULL,
        caption         text,
        sort_order      integer     NOT NULL DEFAULT 0,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_doctor_portfolio_photos_portfolio ON doctor_portfolio_photos(portfolio_id, sort_order)`);

    // Página do Portfólio no catálogo de permissões — exclusiva do médico
    // (não faz sentido pra recepção, é a vitrine pessoal do profissional).
    await query(`
      DO $$
      BEGIN
        IF to_regclass('public.app_pages') IS NOT NULL THEN
          INSERT INTO app_pages (code, name, menu_group, sort_order, member_type, is_owner_only, default_can_view, default_can_create, default_can_update, default_can_delete)
          VALUES
            ('portfolio', 'Portfólio', 'portfolio', 120, 'doctor', false, true, true, true, true),
            ('perfil', 'Meu Perfil', 'minha-conta', 121, 'doctor', false, true, true, true, true)
          ON CONFLICT (code) DO UPDATE
          SET name = excluded.name,
              menu_group = excluded.menu_group,
              sort_order = excluded.sort_order,
              member_type = excluded.member_type,
              active = true,
              updated_at = now();
        END IF;
      END $$;
    `);

    // ═══════════════════════════════════════════════════════════════════
    // SOLICITAÇÕES DE AGENDAMENTO — quando o paciente escolhe um horário
    // no portfólio público, isto grava a "intenção" no sistema (pra ninguém
    // mais conseguir escolher o mesmo horário, e o médico ver a fila sem
    // precisar catar mensagem de WhatsApp uma por uma). O paciente ainda
    // é levado ao WhatsApp normalmente pra falar com o médico — isto aqui
    // só evita que o horário fique "invisível" pro sistema até alguém
    // digitar a consulta manualmente.
    // ═══════════════════════════════════════════════════════════════════
    await query(`
      CREATE TABLE IF NOT EXISTS portfolio_booking_requests (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id        uuid        NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        portfolio_id     uuid        NOT NULL REFERENCES doctor_portfolios(id) ON DELETE CASCADE,
        patient_name     text        NOT NULL,
        patient_phone    text,
        requested_date   date        NOT NULL,
        requested_time   text        NOT NULL,
        status           text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','cancelled')),
        google_event_id  text,
        decided_at       timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_doctor ON portfolio_booking_requests(doctor_id, status, requested_date, requested_time)`);
    // Trava no banco: dois pedidos "ativos" (pending/confirmed) não podem
    // ocupar o mesmo horário do mesmo médico — é o que impede o duplo
    // agendamento mesmo se dois pacientes clicarem quase ao mesmo tempo.
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_requests_active_slot
        ON portfolio_booking_requests(doctor_id, requested_date, requested_time)
        WHERE status IN ('pending','confirmed')
    `);

    console.log('[migrate] Migracoes concluidas com sucesso.');
  } catch (err) {
    console.error('[migrate] Erro ao executar migracoes:', err.message);
    // Nao interrompe o servidor — apenas registra o erro
  }
}

module.exports = { runMigrations };
