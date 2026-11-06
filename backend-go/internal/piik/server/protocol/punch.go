package protocol

import (
	"encoding/hex"
	"errors"
	"net/netip"
)

type PunchPrediction struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	Step    int    `json:"step"`
}

func (v *PunchPrediction) UnmarshalJSON(data []byte) error {
	*v = PunchPrediction{}
	type raw PunchPrediction
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err = present.require("address", "port", "step"); err != nil {
		return err
	}
	address, err := netip.ParseAddr(v.Address)
	if err != nil || !address.Is4() || v.Port < 1024 || v.Port > 65535 || v.Step < 0 || v.Step > 16 || v.Port+4*v.Step > 65535 {
		return errors.New("invalid mapping observation")
	}
	return nil
}

type PunchSignal struct {
	Phase      string           `json:"phase"`
	Secret     string           `json:"secret,omitempty"`
	Prediction *PunchPrediction `json:"prediction,omitempty"`
	Connected  *bool            `json:"connected,omitempty"`
}

func (v *PunchSignal) UnmarshalJSON(data []byte) error {
	*v = PunchSignal{}
	type raw PunchSignal
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err = present.require("phase"); err != nil {
		return err
	}
	valid := false
	switch v.Phase {
	case "prepare":
		key, keyErr := hex.DecodeString(v.Secret)
		valid = len(present) == 2 && keyErr == nil && len(key) == 32 && v.Secret == hex.EncodeToString(key)
	case "ready":
		valid = len(present) == 1 || (len(present) == 2 && v.Prediction != nil)
	case "start":
		valid = len(present) == 2 && v.Prediction != nil
	case "complete":
		valid = len(present) == 2 && v.Connected != nil
	}
	if !valid {
		return errors.New("invalid connection preparation phase")
	}
	return nil
}
