SELECT to_regprocedure('auth.login_candidate(text)') IS NOT NULL
   AND to_regprocedure('auth.upgrade_password_hash(uuid,text,text)') IS NOT NULL;
