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

{{/* The container image reference. */}}
{{- define "volveran.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* The name of the ConfigMap holding profiles.yaml. */}}
{{- define "volveran.profilesConfigMapName" -}}
{{- printf "%s-profiles" (include "volveran.fullname" .) -}}
{{- end -}}

{{/* The profiles.yaml file rendered from brokerProfiles.profiles. */}}
{{- define "volveran.profilesYaml" -}}
{{- dict "profiles" .Values.brokerProfiles.profiles | toYaml -}}
{{- end -}}

{{/* The name of the audit store PersistentVolumeClaim. */}}
{{- define "volveran.dataClaimName" -}}
{{- printf "%s-data" (include "volveran.fullname" .) -}}
{{- end -}}

{{/*
Refuses values the chart cannot run with. The values schema catches most of
these first; these guards give the same answer with --skip-schema-validation
and carry the explanation a schema error cannot.
*/}}
{{- define "volveran.validate" -}}
{{- if ne (int .Values.replicaCount) 1 -}}
{{- fail (printf "replicaCount must be 1, got %v: Volverán holds Checkouts in one process and writes its audit store from a single writer, so the chart runs exactly one replica (see docs/adr/0003-single-replica-on-kubernetes.md)" .Values.replicaCount) -}}
{{- end -}}
{{- $oidc := .Values.oidc | default dict -}}
{{- range $key := list "issuer" "clientId" "redirectUrl" "existingSecret" -}}
{{- if not (get $oidc $key) -}}
{{- fail (printf "oidc.%s is required: Volverán runs in Team Mode and needs the OIDC issuer, client ID, redirect URL and the Secret holding the client and session secrets" $key) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.brokerProfiles.profiles -}}
{{- fail "brokerProfiles.profiles must list at least one Broker Profile" -}}
{{- end -}}
{{- end -}}
