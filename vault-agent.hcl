exit_after_auth = false
pid_file        = "/tmp/vault-agent.pid"

auto_auth {
  method {
    type       = "approle"
    mount_path = "auth/approle"

    config = {
      role_id_file_path                  = "/run/secrets/vault_role_id"
      secret_id_file_path                = "/run/secrets/vault_secret_id"
      remove_secret_id_file_after_reading = false
    }
  }

  sink "file" {
    config = {
      path  = "/vault/token/token"
      mode  = 0440
      owner = 10001
      group = 10001
    }
  }
}
