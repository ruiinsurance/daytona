// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"os"
	"testing"
)

func TestLocalVolumeConfigDefaultsDisabled(t *testing.T) {
	config = nil
	t.Cleanup(func() { config = nil })
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("DAYTONA_API_URL", "http://api.test")
	t.Setenv("DAYTONA_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "runner.test")
	originalEnabled, hadEnabled := os.LookupEnv("LOCAL_VOLUME_BACKEND_ENABLED")
	originalRoot, hadRoot := os.LookupEnv("LOCAL_VOLUME_ROOT")
	_ = os.Unsetenv("LOCAL_VOLUME_BACKEND_ENABLED")
	_ = os.Unsetenv("LOCAL_VOLUME_ROOT")
	t.Cleanup(func() {
		if hadEnabled {
			_ = os.Setenv("LOCAL_VOLUME_BACKEND_ENABLED", originalEnabled)
		}
		if hadRoot {
			_ = os.Setenv("LOCAL_VOLUME_ROOT", originalRoot)
		}
	})

	cfg, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() error = %v", err)
	}
	if cfg.LocalVolumeEnabled {
		t.Fatal("local volume backend enabled without explicit configuration")
	}
	if cfg.LocalVolumeRoot != "/srv/daytona-local-volumes" {
		t.Fatalf("LocalVolumeRoot = %q, want default canonical root", cfg.LocalVolumeRoot)
	}
}
