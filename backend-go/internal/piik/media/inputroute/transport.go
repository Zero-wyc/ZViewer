package inputroute

import "github.com/pion/webrtc/v4"

// ObserveTransport binds the input lifetime to Pion's ordered ICE notifications.
// It owns the transport's public observer; Pion's internal PeerConnection observer
// remains separate. Bind before negotiation, not from asynchronous PC projections.
func ObserveTransport(transport *webrtc.ICETransport, changed func(bool)) {
	transport.OnConnectionStateChange(func(state webrtc.ICETransportState) {
		switch state {
		case webrtc.ICETransportStateConnected, webrtc.ICETransportStateCompleted:
			changed(true)
		case webrtc.ICETransportStateChecking, webrtc.ICETransportStateDisconnected, webrtc.ICETransportStateFailed, webrtc.ICETransportStateClosed:
			changed(false)
		}
	})
}
