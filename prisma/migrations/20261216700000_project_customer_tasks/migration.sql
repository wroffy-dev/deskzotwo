-- Projects phase 3 (owner, 16 Nov 2026): the customer's to do on a stage, and the switch for stage emails to customers.
ALTER TABLE "project_portal_stages" ADD COLUMN "customerTask" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customer_email_settings" ADD COLUMN "projectStageEmails" BOOLEAN NOT NULL DEFAULT true;
