/** R cells share values, while the runner owns isolation, receipts, bounds and interruption. */
export const R_COMPUTATION = String.raw`
local({
  args <- commandArgs(trailingOnly=TRUE)
  token <- args[[1L]]
  wire <- stdout()
  if (length(args) > 1L) .libPaths(c(args[-1L], .libPaths()))
  if (!requireNamespace("jsonlite", quietly=TRUE)) {
    cat(token, '{"kind":"fatal","message":"R computation requires jsonlite. Install it through the governed package tools, then supply its workspace library in rLibraryPaths."}\n', sep="", file=wire)
    flush(wire)
    quit(status=1L)
  }
  send <- function(value) {
    cat(token, jsonlite::toJSON(value, auto_unbox=TRUE, null="null", na="null", digits=NA), "\n", sep="", file=wire)
    flush(wire)
  }
  state <- new.env(parent=globalenv())
  valid_name <- function(name) is.character(name) && length(name)==1L &&
    grepl("^[A-Za-z][A-Za-z0-9_.]*$", name) && identical(make.names(name), name)
  encode <- function(value, depth=0L) {
    if (depth > 12L) stop("Checkpoint exceeds nesting limit")
    type <- typeof(value)
    if (!type %in% c("NULL","logical","integer","double","complex","character","raw","list") || isS4(value))
      stop("R checkpoints accept data values only; functions, environments and S4 objects require an explicit analysis file")
    if (as.numeric(utils::object.size(value)) > 1048576) stop("Checkpoint exceeds one MiB")
    attrs <- attributes(value)
    attributes(value) <- NULL
    data <- switch(type,
      "NULL"=list(),
      "list"=lapply(value, encode, depth=depth+1L),
      "character"=lapply(value, function(x) if(is.na(x)) NULL else x),
      "complex"=lapply(value, function(x) list(sprintf("%.17g",Re(x)),sprintf("%.17g",Im(x)))),
      "double"=as.list(sprintf("%.17g",value)),
      as.list(ifelse(is.na(value),"NA",as.character(value))))
    list(type=type, data=unname(data), attributes=if(is.null(attrs)) NULL else lapply(attrs,encode,depth=depth+1L))
  }
  decode <- function(item, depth=0L) {
    if (depth > 12L || !is.list(item) || !identical(sort(names(item)),sort(c("type","data","attributes"))))
      stop("Invalid R checkpoint value")
    type <- item$type
    if (!is.character(type) || length(type)!=1L || !is.list(item$data)) stop("Invalid R checkpoint type")
    strings <- function() vapply(item$data,function(x) {
      if(is.null(x)) return(NA_character_)
      if(!is.character(x)||length(x)!=1L) stop("Invalid R checkpoint scalar")
      x
    },character(1))
    numeric_values <- function(input=strings(),integer=FALSE) {
      if(anyNA(input)) stop("Invalid numeric checkpoint scalar")
      allowed <- input %in% c("NA","NaN","Inf","-Inf") | grepl("^-?[0-9]+(\\.[0-9]*)?([eE][+-]?[0-9]+)?$",input)
      if(integer) allowed <- input=="NA" | grepl("^-?[0-9]+$",input)
      if(!all(allowed)) stop("Invalid numeric checkpoint scalar")
      result <- if(integer) suppressWarnings(as.integer(input)) else suppressWarnings(as.double(input))
      if(any(is.na(result) & !input %in% c("NA","NaN"))) stop("Numeric checkpoint value is out of range")
      if(any(is.infinite(result) & !input %in% c("Inf","-Inf"))) stop("Numeric checkpoint value is out of range")
      result
    }
    value <- switch(type,
      "NULL"={if(length(item$data)) stop("Invalid NULL checkpoint data"); NULL},
      "logical"={input<-strings(); if(anyNA(input)||!all(input %in% c("TRUE","FALSE","NA"))) stop("Invalid logical checkpoint scalar"); as.logical(input)},
      "integer"=numeric_values(integer=TRUE),
      "double"=numeric_values(),
      "character"=strings(),
      "raw"={input<-strings(); if(anyNA(input)||!all(grepl("^[0-9a-f]{2}$",input))) stop("Invalid raw checkpoint scalar"); as.raw(strtoi(input,16L))},
      "complex"=vapply(item$data,function(x) {
        if(!is.list(x)||length(x)!=2L||!all(vapply(x,function(v)is.character(v)&&length(v)==1L,logical(1)))) stop("Invalid complex checkpoint value")
        parts <- numeric_values(unlist(x,use.names=FALSE))
        complex(real=parts[[1L]],imaginary=parts[[2L]])
      },complex(1)),
      "list"=lapply(item$data,decode,depth=depth+1L),
      stop("Unsupported R checkpoint type"))
    if(!is.null(item$attributes)) {
      if(!is.list(item$attributes)||is.null(names(item$attributes))||anyDuplicated(names(item$attributes))) stop("Invalid R checkpoint attributes")
      attrs <- lapply(item$attributes,decode,depth=depth+1L)
      attributes(value) <- attrs
    }
    value
  }
  summary <- function(value) {
    result <- list(type=typeof(value))
    if(is.null(attributes(value)) && typeof(value) %in% c("character","double","integer","logical") && length(value)==1L && !is.na(value)) {
      if(!is.numeric(value)||is.finite(value)) {
        result$preview <- substr(as.character(value),1L,300L)
        if(nchar(as.character(value),type="bytes")<16000L) result$value <- value
      }
    }
    result
  }
  variables <- function() lapply(head(ls(state,all.names=FALSE),100L),function(name)
    list(name=name,type=if(bindingIsActive(name,state)) "active binding" else "R binding"))
  send(list(kind="ready",runtime=list(version=as.character(getRversion()),platform=R.version$os,architecture=R.version$arch)))
  input <- file("stdin",open="r")
  repeat {
    line <- readLines(input,n=1L,warn=FALSE)
    if(!length(line)) break
    tryCatch({
      request <- jsonlite::fromJSON(line,simplifyVector=FALSE)
      id <- request$cellId
      error <- NULL
      result <- NULL
      artifacts <- list()
      plot_prefixes <- character()
      plot_files <- character()
      plot_devices <- integer()
      old_device <- getOption("device")
      options(device=function(...) {
        if(length(plot_prefixes)>=4L) stop("Cell plot limit reached; save additional plots explicitly")
        prefix <- tempfile("garden-cell-")
        grDevices::png(paste0(prefix,"-%03d.png"),width=1200L,height=800L)
        plot_prefixes <<- c(plot_prefixes,prefix)
        plot_devices <<- c(plot_devices,grDevices::dev.cur())
      })
      tryCatch(withCallingHandlers({
        if(request$action=="checkpoint") {
          names <- unlist(request$variables,use.names=FALSE)
          if(!length(names)||anyDuplicated(names)||!all(vapply(names,valid_name,logical(1)))) stop("Checkpoint requires unique public R variable names")
          values <- lapply(names,function(name) {
            if(!exists(name,state,inherits=FALSE)||bindingIsActive(name,state)) stop("Checkpoint cannot read missing or active bindings")
            encode(get(name,state,inherits=FALSE))
          })
          names(values) <- names
          result <- list(checkpoint=values)
          if(nchar(jsonlite::toJSON(result,auto_unbox=TRUE,null="null"),type="bytes")>1048576L) stop("Checkpoint exceeds one MiB")
        } else if(request$action=="restore") {
          names <- names(request$values)
          if(is.null(names)||anyDuplicated(names)||!all(vapply(names,valid_name,logical(1)))) stop("Invalid R checkpoint names")
          if(any(vapply(names,function(name) exists(name,state,inherits=FALSE) && (bindingIsActive(name,state)||bindingIsLocked(name,state)),logical(1)))) stop("Restore cannot replace active or locked bindings")
          if(environmentIsLocked(state) && any(!vapply(names,exists,logical(1),envir=state,inherits=FALSE))) stop("Restore cannot add bindings to a locked environment")
          values <- lapply(request$values,decode)
          for(name in names) assign(name,values[[name]],envir=state)
        } else {
          expressions <- parse(text=request$code,keep.source=FALSE)
          last <- list(value=NULL,visible=FALSE)
          for(expression in expressions) last <- withVisible(eval(expression,envir=state))
          result <- summary(last$value)
          if(last$visible) print(last$value)
        }
      },warning=function(condition) {
        send(list(kind="output",cellId=id,stream="stderr",text=paste0("Warning: ",substr(conditionMessage(condition),1L,8000L),"\n")))
        invokeRestart("muffleWarning")
      },message=function(condition) {
        send(list(kind="output",cellId=id,stream="stderr",text=substr(conditionMessage(condition),1L,8000L)))
        invokeRestart("muffleMessage")
      }),error=function(condition) {
        error <<- list(message=substr(conditionMessage(condition),1L,8000L),interrupted=FALSE)
      },interrupt=function(condition) {
        error <<- list(message="Cell interrupted",interrupted=TRUE)
      },finally={
        options(device=old_device)
        for(device in plot_devices) if(device %in% grDevices::dev.list()) try(grDevices::dev.off(device),silent=TRUE)
      })
      tryCatch({
        plot_files <- unlist(lapply(plot_prefixes,function(prefix)Sys.glob(paste0(prefix,"-*.png"))),use.names=FALSE)
        if(length(plot_files)>4L) stop("Cell plot limit reached; save additional plots explicitly")
        for(filename in plot_files) {
          if(!file.exists(filename)) next
          size <- file.info(filename)$size
          if(is.na(size)||size>2097152) stop("Plot exceeds two MiB; reduce plot size")
          artifacts[[length(artifacts)+1L]] <- list(mimeType="image/png",base64=jsonlite::base64_enc(readBin(filename,"raw",n=size)))
        }
      },error=function(condition) {
        error <<- list(message=substr(conditionMessage(condition),1L,8000L),interrupted=FALSE)
      },finally=unlink(plot_files))
      send(list(kind="done",cellId=id,result=result,error=error,variables=variables(),artifacts=artifacts))
    },error=function(condition) send(list(kind="fatal",message=substr(conditionMessage(condition),1L,8000L))))
  }
})
`;
