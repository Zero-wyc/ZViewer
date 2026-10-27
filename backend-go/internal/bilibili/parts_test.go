package bilibili

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type partDurationTransport struct{}

func (partDurationTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Request: r,
		Body: io.NopCloser(strings.NewReader(`{"code":0,"data":{"title":"collection","cid":101,"duration":40000,"pages":[{"page":1,"cid":101,"part":"first","duration":212},{"page":2,"cid":202,"part":"second","duration":250}]}}`))}, nil
}

func TestVideoSummaryKeepsIndividualPartDurations(t *testing.T) {
	service := NewService(nil)
	service.Client.SetTransport(partDurationTransport{})
	summary, err := service.VideoSummary(context.Background(), "BV1BDk2YCEHF", "")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Duration != 40000 || len(summary.Pages) != 2 || summary.Pages[0].Duration != 212 || summary.Pages[1].Duration != 250 {
		t.Fatalf("aggregate and part durations mixed: %+v", summary)
	}
}
