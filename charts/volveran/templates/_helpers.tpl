{{/*
Shared names, labels and checks. One template file per kind uses these.
*/}}

{{/* The base name of every object: the release name, plus "-volveran" unless it already contains it. */}}
{{- define "volveran.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels that select the Volverán pod. Fixed for the life of a release. */}}
{{- define "volveran.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "volveran.labels" -}}
{{ include "volveran.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* The container image reference: by digest when one is set (it overrides the tag), else by tag. */}}
{{- define "volveran.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{/* The name of the ConfigMap holding profiles.yaml. */}}
{{- define "volveran.profilesConfigMapName" -}}
{{- .Values.brokerProfiles.existingConfigMap | default (printf "%s-profiles" (include "volveran.fullname" .)) -}}
{{- end -}}

{{/*
The profiles.yaml file rendered from brokerProfiles.profiles, with its format version.
*/}}
{{- define "volveran.profilesYaml" -}}
{{- $file := dict "profiles" .Values.brokerProfiles.profiles "version" 1 -}}
{{- with .Values.brokerProfiles.alertDestinations -}}
{{- $_ := set $file "alertDestinations" . -}}
{{- end -}}
{{- $file | toYaml -}}
{{- end -}}

{{/* The name of the audit store PersistentVolumeClaim. */}}
{{- define "volveran.dataClaimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "volveran.fullname" .)) -}}
{{- end -}}

{{/*
Refuses values the chart cannot run with. The values schema catches most of
these first; these guards give the same answer with --skip-schema-validation
and carry the explanation a schema error cannot.
*/}}
{{- define "volveran.validate" -}}
{{- if lt (int .Values.replicaCount) 1 -}}
{{- fail (printf "replicaCount must be at least 1, got %v" .Values.replicaCount) -}}
{{- end -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- if not .Values.postgres.existingSecret -}}
{{- fail (printf "replicaCount above 1 needs postgres.existingSecret, got %v on SQLite: SQLite has a single writer on one volume, so Replicas must share PostgreSQL (see docs/adr/0014-replicas-forwarding-and-the-background-leader.md)" .Values.replicaCount) -}}
{{- end -}}
{{- if not .Values.forwarding.existingSecret -}}
{{- fail "replicaCount above 1 needs forwarding.existingSecret: an existing Secret holding the secret Replicas forward requests under, at least 32 characters (see docs/replicas.md)" -}}
{{- end -}}
{{- if eq (int .Values.forwarding.port) 8080 -}}
{{- fail "forwarding.port must differ from 8080, the web app's container port" -}}
{{- end -}}
{{- if and .Values.metrics.enabled (eq (int .Values.forwarding.port) (int .Values.metrics.port)) -}}
{{- fail (printf "forwarding.port must differ from metrics.port (both are %d)" (int .Values.metrics.port)) -}}
{{- end -}}
{{- end -}}
{{- $oidc := .Values.oidc | default dict -}}
{{- range $key := list "issuer" "clientId" "redirectUrl" "existingSecret" -}}
{{- if not (get $oidc $key) -}}
{{- fail (printf "oidc.%s is required: Volverán runs in Team Mode and needs the OIDC issuer, client ID, redirect URL and the Secret holding the client and session secrets" $key) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.brokerProfiles.profiles .Values.brokerProfiles.existingConfigMap -}}
{{- fail "brokerProfiles.profiles and brokerProfiles.existingConfigMap are both set: Volverán reads one profiles.yaml, so give either inline profiles or an existing ConfigMap" -}}
{{- end -}}
{{- if not (or .Values.brokerProfiles.profiles .Values.brokerProfiles.existingConfigMap) -}}
{{- fail "brokerProfiles.profiles or brokerProfiles.existingConfigMap is required: list at least one Broker Profile, or name an existing ConfigMap holding profiles.yaml" -}}
{{- end -}}
{{- end -}}

{{/* Each named setting and the VOLVERAN_* variable it becomes, as YAML (settings value: variable). */}}
{{- define "volveran.settingsVariables" -}}
checkoutMaxMessages: VOLVERAN_CHECKOUT_MAX_MESSAGES
checkoutMaxMb: VOLVERAN_CHECKOUT_MAX_MB
checkoutTimeLimitMinutes: VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES
checkoutHeartbeatSeconds: VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS
bodyRetentionDays: VOLVERAN_BODY_RETENTION_DAYS
bodyRetentionMaxBytes: VOLVERAN_BODY_RETENTION_MAX_BYTES
bodyRetentionIntervalMinutes: VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES
historyIntervalSeconds: VOLVERAN_HISTORY_INTERVAL_SECONDS
historyRetentionDays: VOLVERAN_HISTORY_RETENTION_DAYS
{{- end -}}

{{/* The env entries for the settings that are set. Numbers are printed whole (Helm reads them as floats). */}}
{{- define "volveran.settingsEnv" -}}
{{- $settings := .Values.settings | default dict -}}
{{- range $key, $name := include "volveran.settingsVariables" . | fromYaml }}
{{- $value := get $settings $key -}}
{{- if not (kindIs "invalid" $value) }}
- name: {{ $name }}
  value: {{ kindIs "string" $value | ternary $value (printf "%d" (int64 $value)) | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Variables the Deployment always sets; extraEnv may not set them. */}}
{{- define "volveran.fixedVariables" -}}
{{- list "VOLVERAN_AUTH" "VOLVERAN_HOST" "VOLVERAN_PORT" "VOLVERAN_PROFILES_FILE" "VOLVERAN_DATA_DIR" "VOLVERAN_OIDC_ISSUER" "VOLVERAN_OIDC_CLIENT_ID" "VOLVERAN_OIDC_REDIRECT_URL" "VOLVERAN_OIDC_SCOPES" "VOLVERAN_OIDC_CLIENT_SECRET" "VOLVERAN_SESSION_SECRET" "VOLVERAN_SESSION_ENCRYPTION_KEY" | toJson -}}
{{- end -}}

{{/* The directory every CA bundle is mounted under, as <dir>/<bundle name>/<key>. */}}
{{- define "volveran.caBundlesDir" -}}
/etc/volveran/ca
{{- end -}}

{{/*
Refuses values of the optional configuration areas (image, caBundles, settings,
extraEnv, persistence, pod scheduling). Included next to volveran.validate.
*/}}
{{- define "volveran.validateOptions" -}}
{{- $bundleNames := list -}}
{{- range .Values.caBundles.bundles -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,58}[a-z0-9])?$" (.name | default "")) -}}
{{- fail (printf "caBundles.bundles name %q must be lowercase letters, digits and \"-\" (a DNS label of at most 60 characters): it names the mount directory and the volume" (.name | default "")) -}}
{{- end -}}
{{- if has .name $bundleNames -}}
{{- fail (printf "caBundles.bundles names %q twice: each bundle has its own directory under /etc/volveran/ca" .name) -}}
{{- end -}}
{{- $bundleNames = append $bundleNames .name -}}
{{- if eq (empty .configMap) (empty .secret) -}}
{{- fail (printf "caBundles.bundles %q needs exactly one of configMap or secret: the existing object whose keys are mounted as CA files" .name) -}}
{{- end -}}
{{- end -}}
{{- with .Values.caBundles.oidcTrust.bundle -}}
{{- if not (has . $bundleNames) -}}
{{- fail (printf "caBundles.oidcTrust.bundle names %q, which is not in caBundles.bundles: add the bundle there, or leave oidcTrust.bundle empty" .) -}}
{{- end -}}
{{- range $.Values.extraEnv -}}
{{- if eq .name "NODE_EXTRA_CA_CERTS" -}}
{{- fail "extraEnv sets NODE_EXTRA_CA_CERTS: use caBundles.oidcTrust instead, which points it at a mounted bundle" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- with .Values.postgres.ca.bundle -}}
{{- if not $.Values.postgres.existingSecret -}}
{{- fail "postgres.ca.bundle needs postgres.existingSecret: without the Secret holding the URL, the audit store is on SQLite and nothing uses the CA" -}}
{{- end -}}
{{- if not $.Values.postgres.requireTls -}}
{{- fail "postgres.requireTls is false but postgres.ca.bundle is set: a CA is only for TLS, so require it or remove the bundle" -}}
{{- end -}}
{{- if not (has . $bundleNames) -}}
{{- fail (printf "postgres.ca.bundle names %q, which is not in caBundles.bundles: add the bundle there, or leave postgres.ca.bundle empty" .) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.postgres.existingSecret .Values.persistence.existingClaim -}}
{{- fail "persistence.existingClaim is set but postgres.existingSecret keeps the audit store in PostgreSQL, so nothing would use the claim: remove one of them" -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if has .name (list "VOLVERAN_POSTGRES_URL" "VOLVERAN_POSTGRES_REQUIRE_TLS" "VOLVERAN_POSTGRES_CA_FILE") -}}
{{- fail (printf "extraEnv sets %s: use the postgres values instead, so the URL comes from a Secret" .name) -}}
{{- end -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if has .name (list "VOLVERAN_FORWARDING_SECRET" "VOLVERAN_FORWARDING_PORT" "VOLVERAN_FORWARDING_ADDRESS" "VOLVERAN_POD_IP") -}}
{{- fail (printf "extraEnv sets %s: use replicaCount and the forwarding values instead, which also add the port and close it to all but other Replicas" .name) -}}
{{- end -}}
{{- end -}}
{{- $selector := include "volveran.selectorLabels" . | fromYaml -}}
{{- range $key, $_ := .Values.pod.labels -}}
{{- if hasKey $selector $key -}}
{{- fail (printf "pod.labels.%s is set by the chart: it selects the pod for the Deployment and the Service, so it cannot change" $key) -}}
{{- end -}}
{{- end -}}
{{- if hasKey (.Values.pod.annotations | default dict) "checksum/broker-profiles" -}}
{{- fail "pod.annotations.checksum/broker-profiles is set by the chart: it rolls the pod when the Broker Profiles change" -}}
{{- end -}}
{{- if and .Values.metrics.serviceMonitor.enabled (not .Values.metrics.enabled) -}}
{{- fail "metrics.serviceMonitor.enabled needs metrics.enabled: without the metrics port the ServiceMonitor has nothing to scrape" -}}
{{- end -}}
{{- if .Values.metrics.enabled -}}
{{- if eq (int .Values.metrics.port) 8080 -}}
{{- fail "metrics.port must differ from 8080, the web app's container port: metrics are never served on it" -}}
{{- end -}}
{{- if eq (int .Values.metrics.port) (int .Values.service.port) -}}
{{- fail (printf "metrics.port must differ from service.port (both are %d): the Service gives each of them a port of its own" (int .Values.service.port)) -}}
{{- end -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if eq .name "VOLVERAN_METRICS_PORT" -}}
{{- fail "extraEnv sets VOLVERAN_METRICS_PORT: use metrics.enabled and metrics.port instead, which also add the container and Service ports" -}}
{{- end -}}
{{- end -}}
{{- $fixed := include "volveran.fixedVariables" . | fromJsonArray -}}
{{- $settings := include "volveran.settingsVariables" . | fromYaml -}}
{{- range .Values.extraEnv -}}
{{- if has .name $fixed -}}
{{- fail (printf "extraEnv sets %s, which the chart sets itself: Volverán on Kubernetes always runs Team Mode on 0.0.0.0:8080 with the oidc values" .name) -}}
{{- end -}}
{{- $entry := . -}}
{{- range $key, $name := $settings -}}
{{- if eq $name $entry.name -}}
{{- fail (printf "extraEnv sets %s: use settings.%s instead" $name $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (not .Values.persistence.enabled) .Values.persistence.existingClaim -}}
{{- fail "persistence.existingClaim is set but persistence.enabled is false: turn persistence on to use the claim, or remove existingClaim" -}}
{{- end -}}
{{- with .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .) -}}
{{- fail (printf "image.digest must look like sha256:<64 lowercase hex digits>, got %q" .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
