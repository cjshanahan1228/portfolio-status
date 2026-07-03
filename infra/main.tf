terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "location" {
  type    = string
  default = "eastus2"
}

variable "site_url" {
  description = "The site the availability test pings"
  type        = string
  default     = "https://colinshanahan.dev"
}

variable "allowed_origins" {
  description = "CORS origins allowed to call the status API"
  type        = list(string)
  default     = ["https://colinshanahan.dev", "https://www.colinshanahan.dev"]
}

variable "github_repo" {
  description = "owner/repo of THIS status project, for OIDC deploys"
  type        = string
  default     = "cjshanahan1228/portfolio-status"
}

resource "azurerm_resource_group" "status" {
  name     = "rg-portfolio-status"
  location = var.location
}

# ── Telemetry: workspace + App Insights + synthetic availability test ──────
resource "azurerm_log_analytics_workspace" "status" {
  name                = "log-portfolio-status"
  resource_group_name = azurerm_resource_group.status.name
  location            = azurerm_resource_group.status.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_application_insights" "site" {
  name                = "appi-colinshanahan-dev"
  resource_group_name = azurerm_resource_group.status.name
  location            = azurerm_resource_group.status.location
  workspace_id        = azurerm_log_analytics_workspace.status.id
  application_type    = "web"
}

# Real synthetic monitoring: ping the site every 5 min from three US regions.
resource "azurerm_application_insights_standard_web_test" "site" {
  name                    = "avail-colinshanahan-dev"
  resource_group_name     = azurerm_resource_group.status.name
  location                = azurerm_resource_group.status.location
  application_insights_id = azurerm_application_insights.site.id
  geo_locations           = ["us-va-ash-azr", "us-il-ch1-azr", "us-tx-sn1-azr"]
  frequency               = 300
  timeout                 = 30
  enabled                 = true
  retry_enabled           = true

  request {
    url = var.site_url
  }

  validation_rules {
    expected_status_code = 200
    ssl_check_enabled    = true
    ssl_cert_remaining_lifetime = 7 # fail the check if the cert is about to expire
  }
}

# ── The status API: consumption Function App ───────────────────────────────
resource "azurerm_storage_account" "func" {
  name                            = "stcolinstatusfunc"
  resource_group_name             = azurerm_resource_group.status.name
  location                        = azurerm_resource_group.status.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
}

resource "azurerm_service_plan" "func" {
  name                = "asp-portfolio-status"
  resource_group_name = azurerm_resource_group.status.name
  location            = azurerm_resource_group.status.location
  os_type             = "Linux"
  sku_name            = "Y1" # consumption — effectively free at this traffic
}

resource "azurerm_linux_function_app" "status" {
  name                = "func-colinshanahan-status" # -> func-colinshanahan-status.azurewebsites.net
  resource_group_name = azurerm_resource_group.status.name
  location            = azurerm_resource_group.status.location
  service_plan_id     = azurerm_service_plan.func.id

  storage_account_name       = azurerm_storage_account.func.name
  storage_account_access_key = azurerm_storage_account.func.primary_access_key

  identity {
    type = "SystemAssigned" # this is how the API reads telemetry — no keys
  }

  site_config {
    application_stack {
      node_version = "20"
    }
    cors {
      allowed_origins = var.allowed_origins
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME              = "node"
    LOG_ANALYTICS_WORKSPACE_ID            = azurerm_log_analytics_workspace.status.workspace_id
    GITHUB_REPO                           = "cjshanahan1228/colinshanahan.dev-portfolio"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.site.connection_string
  }
}

# Least privilege: the API may READ logs in this one workspace. Nothing else.
resource "azurerm_role_assignment" "func_logs_reader" {
  scope                = azurerm_log_analytics_workspace.status.id
  role_definition_name = "Log Analytics Reader"
  principal_id         = azurerm_linux_function_app.status.identity[0].principal_id
}

# ── CI identity: GitHub OIDC, scoped to this resource group only ───────────
resource "azurerm_user_assigned_identity" "github" {
  name                = "id-github-status-deploy"
  resource_group_name = azurerm_resource_group.status.name
  location            = azurerm_resource_group.status.location
}

resource "azurerm_federated_identity_credential" "github_main" {
  name                = "github-main"
  resource_group_name = azurerm_resource_group.status.name
  parent_id           = azurerm_user_assigned_identity.github.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_repo}:ref:refs/heads/main"
}

resource "azurerm_role_assignment" "github_deployer" {
  scope                = azurerm_resource_group.status.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github.principal_id
}

# ── Outputs ────────────────────────────────────────────────────────────────
data "azurerm_client_config" "current" {}

output "status_api_url" {
  value = "https://${azurerm_linux_function_app.status.default_hostname}/api/status"
}

output "azure_client_id" {
  value = azurerm_user_assigned_identity.github.client_id
}

output "azure_tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "azure_subscription_id" {
  value = data.azurerm_client_config.current.subscription_id
}
