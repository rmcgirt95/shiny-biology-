library(shiny)
library(ggplot2)

# Read Salmon quant.sf (tab-delimited)
quant <- read.table("quant.sf", header = TRUE, sep = "\t", stringsAsFactors = FALSE)

ui <- fluidPage(
  titlePanel("Salmon quant.sf Scatter Plot"),
  sidebarLayout(
    sidebarPanel(
      selectInput("xvar", "X-axis",
                  choices = c("Length", "EffectiveLength", "TPM", "NumReads"),
                  selected = "EffectiveLength"),
      selectInput("yvar", "Y-axis",
                  choices = c("TPM", "NumReads"),
                  selected = "TPM"),
      checkboxInput("logx", "Log X (log10)", FALSE),
      checkboxInput("logy", "Log Y (log10)", TRUE),
      sliderInput("alpha", "Point transparency", min = 0.05, max = 1.0, value = 0.4, step = 0.05),
      numericInput("max_points", "Max points (speed)", value = 50000, min = 1000, step = 1000)
    ),
    mainPanel(
      plotOutput("scatter", height = "650px")
    )
  )
)

server <- function(input, output, session) {

  output$scatter <- renderPlot({
    df <- quant

    # Optional downsample for speed on very large files
    if (nrow(df) > input$max_points) {
      set.seed(1)
      df <- df[sample.int(nrow(df), input$max_points), ]
    }

    p <- ggplot(df, aes(x = .data[[input$xvar]], y = .data[[input$yvar]])) +
      geom_point(alpha = input$alpha) +
      theme_minimal() +
      labs(
        x = input$xvar,
        y = input$yvar,
        title = paste(input$yvar, "vs", input$xvar)
      )

    if (input$logx) p <- p + scale_x_log10()
    if (input$logy) p <- p + scale_y_log10()

    p
  })
}

shinyApp(ui, server)
