// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"os"
	"testing"
)

func setRequiredTestEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DAYTONA_API_URL", "https://api.example.test")
	t.Setenv("DAYTONA_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "runner.example.test")
	config = nil
	t.Cleanup(func() {
		config = nil
	})
}

func TestGetConfigReadsSingleBucketVolumeSettings(t *testing.T) {
	setRequiredTestEnvironment(t)
	t.Setenv("AWS_VOLUME_LAYOUT", singleBucketPrefixLayout)
	t.Setenv("AWS_DEFAULT_BUCKET", "daytona-test-1250000000")
	t.Setenv("AWS_VOLUME_PREFIX", "r3-prod/daytona/volumes")

	cfg, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() error = %v", err)
	}
	if cfg.AWSVolumeLayout != singleBucketPrefixLayout {
		t.Fatalf("AWSVolumeLayout = %q, want %q", cfg.AWSVolumeLayout, singleBucketPrefixLayout)
	}
	if cfg.AWSDefaultBucket != "daytona-test-1250000000" {
		t.Fatalf("AWSDefaultBucket = %q", cfg.AWSDefaultBucket)
	}
	if cfg.AWSVolumePrefix != "r3-prod/daytona/volumes" {
		t.Fatalf("AWSVolumePrefix = %q", cfg.AWSVolumePrefix)
	}
}

func TestGetConfigDefaultsToPerVolumeBucketLayout(t *testing.T) {
	setRequiredTestEnvironment(t)
	previous, existed := os.LookupEnv("AWS_VOLUME_LAYOUT")
	if err := os.Unsetenv("AWS_VOLUME_LAYOUT"); err != nil {
		t.Fatalf("unset AWS_VOLUME_LAYOUT: %v", err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv("AWS_VOLUME_LAYOUT", previous)
		} else {
			_ = os.Unsetenv("AWS_VOLUME_LAYOUT")
		}
	})

	cfg, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() error = %v", err)
	}
	if cfg.AWSVolumeLayout != perVolumeBucketLayout {
		t.Fatalf("AWSVolumeLayout = %q, want %q", cfg.AWSVolumeLayout, perVolumeBucketLayout)
	}
}

func TestGetConfigRejectsIncompleteSingleBucketVolumeSettings(t *testing.T) {
	for _, missing := range []string{"AWS_DEFAULT_BUCKET", "AWS_VOLUME_PREFIX"} {
		t.Run(missing, func(t *testing.T) {
			setRequiredTestEnvironment(t)
			t.Setenv("AWS_VOLUME_LAYOUT", singleBucketPrefixLayout)
			t.Setenv("AWS_DEFAULT_BUCKET", "daytona-test-1250000000")
			t.Setenv("AWS_VOLUME_PREFIX", "r3-prod/daytona/volumes")
			t.Setenv(missing, "")

			if _, err := GetConfig(); err == nil {
				t.Fatalf("GetConfig() succeeded with empty %s", missing)
			}
		})
	}
}

const (
	perVolumeBucketLayout    = "per-volume-bucket"
	singleBucketPrefixLayout = "single-bucket-prefix"
)
